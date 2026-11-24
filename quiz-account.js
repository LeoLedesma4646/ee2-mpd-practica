import config from './firebase-config.js';

const bankLabels = { general: 'General', profesor: 'Profesor' };
const bankIds = Object.keys(bankLabels);
const empty = { revision: 0, text: null, value: null };
const loginText = {
  signin: ['Iniciar sesión', 'Retoma tu avance en cualquier dispositivo.', 'Entrar'],
  signup: ['Crear cuenta', 'Usa tu correo y una contraseña de al menos 8 caracteres.', 'Crear cuenta'],
  reset: ['Recuperar contraseña', 'Ingresa el correo de tu cuenta.', 'Enviar enlace'],
};

export async function connectAccounts(quiz) {
  if (!config) return;
  const { emulator = false, google = false, ...firebaseConfig } = config;
  const [core, authentication, firestore] = await Promise.all([
    import('https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js'),
    import('https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js'),
  ]);
  const app = core.initializeApp(firebaseConfig);
  const auth = authentication.getAuth(app);
  const db = firestore.getFirestore(app);
  if (emulator && ['localhost', '127.0.0.1'].includes(location.hostname)) {
    authentication.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    firestore.connectFirestoreEmulator(db, '127.0.0.1', 8080);
  }
  auth.languageCode = 'es';
  const actionSettings = { url: location.origin + location.pathname };

  const ui = Object.fromEntries([
    'entry', 'sync', 'dialog', 'title', 'close', 'description', 'form', 'email',
    'password', 'password-row', 'submit', 'options', 'notice',
  ].map(id => [id, document.getElementById('account-' + id)]));

  let mode = 'signin';
  let busy = false;
  let owner = null;
  let exiting = false;

  function notice(text = '', error = false) {
    ui.notice.textContent = text;
    ui.notice.hidden = !text;
    ui.notice.dataset.error = String(error);
  }

  function warnUnsaved(event) {
    event.preventDefault();
    event.returnValue = true;
  }

  function renderIndicator() {
    const text = owner?.conflicts.size ? 'Avance por revisar'
      : owner?.failed.size ? 'Guardado pendiente'
      : owner?.pending.size ? 'Guardando…'
      : owner?.ready ? 'Avance guardado'
      : '';
    ui.sync.textContent = text;
    ui.sync.hidden = !text;
    if (owner?.pending.size) window.addEventListener('beforeunload', warnUnsaved);
    else window.removeEventListener('beforeunload', warnUnsaved);
  }

  function option(label, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'account-link';
    button.textContent = label;
    button.disabled = busy;
    button.addEventListener('click', action);
    ui.options.append(button);
  }

  function choose(nextMode) {
    mode = nextMode;
    ui.password.value = '';
    notice();
    render();
    ui.email.focus();
  }

  function render() {
    renderIndicator();
    ui.options.replaceChildren();
    ui.entry.textContent = owner ? 'Mi cuenta' : 'Entrar';
    ui.form.hidden = Boolean(owner);
    ui.submit.disabled = busy;
    if (!owner) {
      const [title, description, submit] = loginText[mode];
      ui.title.textContent = title;
      ui.description.textContent = description;
      ui.submit.textContent = submit;
      ui['password-row'].hidden = mode === 'reset';
      ui.password.required = mode !== 'reset';
      ui.password.minLength = mode === 'signup' ? 8 : 0;
      ui.password.autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
      if (mode !== 'reset' && google) option('Continuar con Google', () => work(signInWithGoogle));
      if (mode === 'signin') {
        option('Crear cuenta', () => choose('signup'));
        option('Olvidé mi contraseña', () => choose('reset'));
        option('Seguir como invitado', () => ui.dialog.close());
      } else {
        option('Volver a iniciar sesión', () => choose('signin'));
      }
      return;
    }

    ui.title.textContent = 'Mi cuenta';
    ui.description.textContent = owner.user.email;
    if (!owner.user.emailVerified) {
      ui.title.textContent = 'Confirma tu correo';
      ui.description.textContent = 'Abre el enlace que enviamos a ' + owner.user.email + ' para guardar tu avance.';
      option('Ya confirmé mi correo', () => work(checkVerification));
      option('Reenviar correo', () => work(sendVerification));
    } else if (!owner.ready) {
      ui.description.textContent = owner.loading ? 'Cargando tu avance…' : 'No se pudo cargar tu avance. Puedes seguir practicando como invitado.';
      if (!owner.loading) option('Volver a cargar mi avance', () => load(owner));
    } else if (exiting && owner.pending.size) {
      ui.description.textContent = 'Hay cambios pendientes de guardar.';
      option('Volver a mi cuenta', () => { exiting = false; render(); });
      option('Salir sin guardar los cambios', () => work(() => authentication.signOut(auth)));
      return;
    } else {
      if (owner.failed.size) option('Reintentar guardado', () => retry(owner));
      for (const bank of owner.conflicts) {
        option(bankLabels[bank] + ' · Usar avance guardado', () => work(() => resolveConflict(bank, false)));
        option(bankLabels[bank] + ' · Guardar avance de este dispositivo', () => work(() => resolveConflict(bank, true)));
      }
      if (owner.conflicts.size) ui.description.textContent = 'Hay cambios en otro dispositivo. Elige qué avance conservar en cada balotario.';
      if (importable(owner).length) option('Guardar mi avance de invitado', importGuest);
    }
    option('Cerrar sesión', () => {
      if (owner.pending.size) {
        exiting = true;
        render();
      } else {
        work(() => authentication.signOut(auth));
      }
    });
  }

  async function work(action) {
    if (busy) return;
    busy = true;
    notice();
    render();
    try {
      await action();
    } catch (error) {
      const errors = {
        'auth/invalid-credential': 'El correo o la contraseña no coinciden.',
        'auth/invalid-email': 'Revisa el correo que escribiste.',
        'auth/email-already-in-use': 'Ese correo ya tiene una cuenta. Puedes iniciar sesión o recuperar la contraseña.',
        'auth/weak-password': 'Usa una contraseña de al menos 8 caracteres.',
        'auth/too-many-requests': 'Hubo demasiados intentos. Vuelve a probar más tarde.',
        'auth/network-request-failed': 'Revisa tu conexión y vuelve a intentar.',
        'auth/popup-blocked': 'Tu navegador bloqueó la ventana de Google. Permite las ventanas emergentes y vuelve a intentar.',
        'auth/popup-closed-by-user': 'Cerraste la ventana de Google. Puedes volver a abrirla.',
        'auth/account-exists-with-different-credential': 'Ya hay una cuenta con ese correo. Entra con el método que usaste al registrarte.',
      };
      notice(errors[error.code] ?? 'No se pudo completar la acción. Vuelve a intentar.', true);
    } finally {
      busy = false;
      render();
    }
  }

  function signInWithGoogle() {
    const provider = new authentication.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    return authentication.signInWithPopup(auth, provider);
  }

  async function sendVerification() {
    await authentication.sendEmailVerification(auth.currentUser, actionSettings);
    notice('Te enviamos un correo de verificación. Revisa también la carpeta de spam.');
  }

  async function checkVerification() {
    const current = owner;
    await authentication.reload(current.user);
    if (!owns(current)) return;
    if (!current.user.emailVerified) {
      notice('Tu correo todavía está pendiente de confirmación.', true);
      return;
    }
    await current.user.getIdToken(true);
    await load(current);
  }

  function owns(current) {
    return current === owner && auth.currentUser?.uid === current.user.uid;
  }

  function ref(current, bank) {
    return firestore.doc(db, 'users', current.user.uid, 'progress', bank);
  }

  function decode(bank, remote) {
    if (!remote.exists()) return empty;
    const data = remote.data();
    const value = data.version === 1 ? quiz.decode(bank, data.snapshot) : null;
    if (!value) throw new Error('Formato de avance desconocido');
    return { revision: data.revision, text: data.snapshot, value };
  }

  async function load(current) {
    if (!owns(current) || current.loading || current.ready) return;
    current.loading = true;
    render();
    try {
      const rows = await Promise.all(bankIds.map(async bank => {
        const remote = await firestore.getDocFromServer(ref(current, bank));
        return [bank, decode(bank, remote)];
      }));
      if (!owns(current)) return;
      current.saved = new Map(rows);
      current.ready = true;
      quiz.enter(rows.map(([bank, data]) => [bank, data.value]),
        (bank, text) => enqueue(current, bank, text));
      notice();
    } catch {
      if (owns(current)) notice('Revisa tu conexión y vuelve a cargar tu avance.', true);
    } finally {
      current.loading = false;
      if (owns(current)) render();
    }
  }

  function importable(current) {
    return bankIds.filter(bank => !current.saved.get(bank).revision &&
      !current.pending.has(bank) && quiz.guest(bank));
  }

  function importGuest() {
    for (const bank of importable(owner)) {
      const text = quiz.guest(bank);
      quiz.replace(bank, quiz.decode(bank, text));
      enqueue(owner, bank, text);
    }
    notice('Guardando el avance que tenías como invitado.');
    render();
  }

  function enqueue(current, bank, text) {
    if (!owns(current)) return;
    if (current.saved.get(bank).text === text && !current.saving.has(bank) &&
        !current.conflicts.has(bank)) {
      current.pending.delete(bank);
      current.failed.delete(bank);
    } else {
      current.pending.set(bank, text);
    }
    renderIndicator();
    schedule(current);
  }

  function schedule(current) {
    clearTimeout(current.timer);
    current.timer = setTimeout(() => {
      if (!owns(current)) return;
      for (const [bank, text] of current.pending) {
        if (!current.saving.has(bank) && !current.failed.has(bank) && !current.conflicts.has(bank)) {
          void save(current, bank, text);
        }
      }
    }, 250);
  }

  async function save(current, bank, text) {
    current.saving.add(bank);
    const reference = ref(current, bank);
    const expected = current.saved.get(bank).revision;
    try {
      const saved = await firestore.runTransaction(db, async transaction => {
        const remote = await transaction.get(reference);
        if (!owns(current)) throw new Error('Sesión cerrada');
        const previous = decode(bank, remote);
        if (previous.text === text) return previous;
        if (previous.revision !== expected) return null;
        const revision = previous.revision + 1;
        transaction.set(reference, { version: 1, revision, snapshot: text });
        return { revision, text, value: quiz.decode(bank, text) };
      });
      if (!owns(current)) return;
      if (saved) {
        current.saved.set(bank, saved);
        if (current.pending.get(bank) === text) current.pending.delete(bank);
      } else {
        current.conflicts.add(bank);
      }
    } catch {
      if (owns(current)) current.failed.add(bank);
    } finally {
      current.saving.delete(bank);
      if (owns(current)) {
        render();
        schedule(current);
      }
    }
  }

  function retry(current) {
    if (!current?.ready) return;
    current.failed.clear();
    schedule(current);
    render();
  }

  async function resolveConflict(bank, keepDevice) {
    const current = owner;
    const remote = await firestore.getDocFromServer(ref(current, bank));
    if (!owns(current)) return;
    const saved = decode(bank, remote);
    current.saved.set(bank, saved);
    current.conflicts.delete(bank);
    if (!keepDevice) {
      current.pending.delete(bank);
      quiz.replace(bank, saved.value);
    }
    schedule(current);
  }

  ui.entry.addEventListener('click', () => {
    exiting = false;
    render();
    ui.dialog.showModal();
    (owner ? ui.close : ui.email).focus();
  });
  ui.close.addEventListener('click', () => ui.dialog.close());
  ui.dialog.addEventListener('close', () => { ui.password.value = ''; });
  ui.form.addEventListener('submit', event => {
    event.preventDefault();
    const email = ui.email.value.trim();
    const password = ui.password.value;
    void work(async () => {
      if (mode === 'reset') {
        try {
          await authentication.sendPasswordResetEmail(auth, email, actionSettings);
        } catch (error) {
          if (error.code !== 'auth/user-not-found') throw error;
        }
        notice('Si existe una cuenta con ese correo, recibirás un enlace para recuperar tu contraseña.');
      } else if (mode === 'signup') {
        await authentication.createUserWithEmailAndPassword(auth, email, password);
        try {
          await sendVerification();
        } catch {
          notice('Tu cuenta está creada. Usa «Reenviar correo» para recibir el enlace de verificación.', true);
        }
      } else {
        await authentication.signInWithEmailAndPassword(auth, email, password);
      }
      ui.password.value = '';
    });
  });
  window.addEventListener('online', () => retry(owner));

  authentication.onAuthStateChanged(auth, user => {
    if (owner) clearTimeout(owner.timer);
    quiz.leave();
    owner = user ? {
      user, ready: false, loading: false, saved: new Map(), pending: new Map(),
      saving: new Set(), failed: new Set(), conflicts: new Set(), timer: undefined,
    } : null;
    notice();
    exiting = false;
    mode = 'signin';
    ui.password.value = '';
    if (!user) ui.email.value = '';
    ui.entry.hidden = false;
    render();
    if (user?.emailVerified) void load(owner);
  });
}
