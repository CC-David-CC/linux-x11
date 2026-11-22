// v86 installs keyboard and pointer listeners on its window. Give each guest
// its own document so it receives input only while its WebOS view has focus.
export function mount(host) {
    const element = document.createElement('div');
    element.className = 'window-content linux-x11';
    Object.assign(element.style, {display: 'flex', flexDirection: 'column', overflow: 'hidden'});
    const frame = document.createElement('iframe');
    frame.title = 'Linux X11 desktop';
    Object.assign(frame.style, {border: '0', flex: '1', minHeight: '0', width: '100%'});
    const status = document.createElement('div');
    status.setAttribute('role', 'status');
    status.dataset.stage = 'runtime';
    status.textContent = 'Loading the Linux emulator…';
    element.append(status, frame);

    let closed = false;
    let home;
    let guest;
    let unregisterWriter;
    const lifetime = new AbortController();
    const dispose = () => {
        if (closed) return;
        closed = true;
        lifetime.abort();
        unregisterWriter?.();
        home?.close();
        guest?.dispose();
        frame.remove();
    };
    function report(message, stage = 'error') {
        if (closed) return;
        status.dataset.stage = stage;
        if (status.textContent !== message) status.textContent = message;
        status.hidden = !message;
    }
    async function pauseFileWriter() {
        const current = guest;
        if (!current?.running()) throw Error('Wait for Linux X11 to start before transferring My files.');
        await current.pause();
        const resume = async () => { if (!closed) await current.resume(); };
        try {
            await home.flush();
            return resume;
        } catch (error) {
            await resume();
            throw error;
        }
    }
    async function requestClose({scope} = {}) {
        if (home && guest?.running()) {
            const resume = await pauseFileWriter();
            // The desktop can still cancel a session-wide close after asking the views.
            if (scope !== 'window') await resume();
        }
        return true;
    }
    async function start() {
        const view = frame.contentWindow;
        try {
            if (typeof view.bootX11 !== 'function') throw Error('Could not load the X11 runtime.');
            let handle = null;
            const storageHost = host.storage;
            const fileContext = storageHost?.workspaceFileContext ||
                (storageHost?.signedInSubject?.() && storageHost.accountFileContext);
            if (fileContext) {
                report('Connecting to My files…', 'home');
                const [ctx, storage, linux] = await Promise.all([
                    fileContext.call(storageHost),
                    import('/storage/browser/account-home.mjs'),
                    import('/assets/desktop/account-home-9p.mjs'),
                ]);
                if (closed) return;
                if (!ctx.valid()) throw Error('Account changed while starting Linux.');
                home = linux.createAccountHome9p(storage.createAccountHome(ctx));
                unregisterWriter = ctx.registerFileWriter?.(pauseFileWriter);
                handle = packet => home.request(new Uint8Array(packet));
            }
            const attachNetwork = await host.prepareGuestNetwork?.(lifetime.signal);
            if (!closed) guest = view.bootX11(handle, report, attachNetwork);
        } catch (error) {
            report('Linux X11 could not start. ' + error.message);
        }
    }
    frame.addEventListener('load', start, {once: true});
    frame.src = new URL('./session.html', import.meta.url).href;
    host.onDispose?.(dispose);
    return {element, dispose, requestClose, focus: () => frame.focus()};
}
