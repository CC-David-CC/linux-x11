'use strict';
window.bootX11 = function bootX11(handle, report) {
    const screen = document.getElementById('screen');
    let disposed = false;
    let pendingSerial = '';
    const vm = new V86({
        wasm_path: '/assets/terminal/v86/v86.wasm',
        bios: {url: '/assets/terminal/v86/seabios.bin'},
        vga_bios: {url: '/assets/terminal/v86/vgabios.bin'},
        bzimage: {url: '/assets/terminal/v86/vmlinuz'},
        initrd: {url: new URL('./graphics.cpio.gz', document.baseURI).href},
        cmdline: 'console=ttyS0,115200n8 rdinit=/x11/init panic=-1 loglevel=4',
        memory_size: 512 * 1024 * 1024,
        vga_memory_size: 8 * 1024 * 1024,
        screen_container: screen,
        filesystem: handle ? {handle9p(packet, reply) {
            handle(packet).then(result => {
                if (!disposed) reply(new Uint8Array(result));
            }).catch(() => report('Account storage is unavailable. Reopen the X11 window.'));
        }} : {},
        autostart: true,
        disable_speaker: true,
    });
    vm.add_listener('emulator-ready', () => {
        if (handle || disposed) return;
        const root = vm.fs9p.GetInode(0);
        root.uid = root.gid = 1000;
        root.mode = 0o40700;
    });
    vm.add_listener('download-error', () => report('Could not download the Linux guest. Reopen the X11 window.'));
    vm.add_listener('serial0-output-byte', byte => {
        if (byte === 10) {
            const line = pendingSerial.trim();
            if (line.startsWith('X.Org X Server ')) report('Starting xterm and xclock…');
            if (line === 'X11 session ready') report('');
            if (line === 'X11 clients did not become ready') report('The graphical desktop could not start its applications.');
            if (/Kernel panic|Fatal server error/.test(pendingSerial)) report('Linux could not start the graphical session.');
            pendingSerial = '';
        } else if (pendingSerial.length < 1024) pendingSerial += String.fromCharCode(byte);
    });
    const canvas = screen.querySelector('canvas');
    canvas.tabIndex = 0;
    // v86 consumes mouse events. Take focus before its default prevention
    // so the next physical key goes to this window's PS/2 keyboard.
    function focusCanvas() {
        canvas.focus({preventScroll: true});
    }
    canvas.addEventListener('pointerdown', focusCanvas);
    function resize() {
        if (!canvas.width || !canvas.height) return;
        const scale = Math.min(innerWidth / canvas.width, innerHeight / canvas.height, 1);
        if (scale > 0) vm.screen_set_scale(scale, scale);
    }
    window.addEventListener('resize', resize);
    const observer = new MutationObserver(resize);
    observer.observe(canvas, {attributes: true, attributeFilter: ['width', 'height']});
    function dispose() {
        if (disposed) return;
        disposed = true;
        observer.disconnect();
        canvas.removeEventListener('pointerdown', focusCanvas);
        window.removeEventListener('resize', resize);
        window.removeEventListener('pagehide', dispose);
        void vm.destroy();
    }
    window.addEventListener('pagehide', dispose, {once: true});
    return {dispose};
};
