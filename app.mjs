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
    const dispose = () => {
        if (closed) return;
        closed = true;
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
    async function start() {
        const view = frame.contentWindow;
        try {
            if (typeof view.bootX11 !== 'function') throw Error('Could not load the X11 runtime.');
            let handle = null;
            if (host.storage?.signedInSubject()) {
                report('Connecting to My files…', 'account');
                const [ctx, storage, linux] = await Promise.all([
                    host.storage.accountFileContext(),
                    import('/storage/browser/account-home.mjs'),
                    import('/assets/desktop/account-home-9p.mjs'),
                ]);
                if (closed) return;
                if (!ctx.valid()) throw Error('Account changed while starting Linux.');
                home = linux.createAccountHome9p(storage.createAccountHome(ctx));
                handle = packet => home.request(new Uint8Array(packet));
            }
            if (!closed) guest = view.bootX11(handle, report);
        } catch (error) {
            report('Linux X11 could not start. ' + error.message);
        }
    }
    frame.addEventListener('load', start, {once: true});
    frame.src = new URL('./session.html', import.meta.url).href;
    host.onDispose?.(dispose);
    return {element, dispose, focus: () => frame.focus()};
}
