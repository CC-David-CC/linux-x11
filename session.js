'use strict';
const x11BootMessages = new Map([
    ['X11 guest init', ['Starting Linux guest services…', 'init']],
    ['X11 mounting home', ['Mounting the guest home…', 'home']],
    ['X11 home mount failed', ['Linux could not mount its home. Reopen the X11 window to retry.', 'error']],
    ['X11 mounting Chromium disk', ['Mounting the Chromium disk…', 'browser-disk']],
    ['X11 starting Xorg', ['Starting the graphical desktop…', 'xorg']],
    ['X11 starting clients', ['Opening xterm and xclock…', 'clients']],
    ['X11 session ready', ['', 'ready']],
    ['X11 clients did not become ready', ['The graphical desktop could not start its applications.', 'error']],
    ['X11 display did not become ready', ['Linux could not start the graphical display.', 'error']],
]);

window.bootX11 = function bootX11(handle, report, attachNetwork) {
    const screen = document.getElementById('screen');
    let disposed = false;
    let pendingSerial = '';
    const diskBytes = Number(document.documentElement.dataset.chromiumDiskBytes || 0);
    const chromium = diskBytes > 0;
    const asset = name => new URL(name, document.baseURI).href;
    const initrd = asset('./graphics.cpio.gz');
    let browserDiskError = false;
    report('Loading the Linux guest image…', 'download');
    const vm = new V86({
        wasm_path: chromium ? asset('./v86-chromium.wasm') : '/assets/terminal/v86/v86.wasm',
        bios: {url: '/assets/terminal/v86/seabios.bin'},
        vga_bios: {url: '/assets/terminal/v86/vgabios.bin'},
        bzimage: {url: '/assets/terminal/v86/vmlinuz'},
        initrd: {url: initrd},
        cmdline: 'console=ttyS0,115200n8 rdinit=/x11/init panic=-1 loglevel=4' + (chromium ? ' webos_chromium=1' : '') + (attachNetwork ? ' guest_net=1' : ''),
        ...(attachNetwork && {net_device: {type: 'virtio'}}),
        memory_size: (chromium ? 1024 : 512) * 1024 * 1024,
        ...(chromium && {hda: {url: asset('./browser.sqfs'), size: diskBytes, async: true, fixed_chunk_size: 256 * 1024}}),
        vga_memory_size: 8 * 1024 * 1024,
        screen_container: screen,
        filesystem: handle ? {handle9p(packet, reply) {
            handle(packet).then(result => {
                if (!disposed) reply(new Uint8Array(result));
            }).catch(() => report('My files are unavailable. Reopen the X11 window.'));
        }} : {},
        autostart: true,
        disable_speaker: true,
    });
    try { attachNetwork?.(vm); }
    catch (error) { void vm.destroy(); throw error; }
    vm.add_listener('download-progress', ({file_name, loaded, total, lengthComputable}) => {
        if (file_name === initrd && lengthComputable && total > 0) {
            const percent = Math.min(100, Math.floor(loaded * 100 / total));
            report(`Downloading the Linux guest image · ${percent}%`, 'download');
        }
    });
    vm.add_listener('emulator-ready', () => {
        report('Booting the Linux kernel…', 'kernel');
        if (handle || disposed) return;
        const root = vm.fs9p.GetInode(0);
        root.uid = root.gid = 1000;
        root.mode = 0o40700;
    });
    vm.add_listener('download-error', () => report('Could not download the Linux guest. Reopen the X11 window.'));
    vm.add_listener('serial0-output-byte', byte => {
        if (byte === 10) {
            const line = pendingSerial.trim();
            const status = x11BootMessages.get(line);
            if (line === 'Chromium disk could not mount') {
                browserDiskError = true;
                document.documentElement.dataset.chromiumDisk = 'error';
            } else if (line === 'Chromium disk ready') {
                document.documentElement.dataset.chromiumDisk = 'ready';
            }
            if (line === 'X11 session ready' && browserDiskError) {
                report('Linux X11 is ready. The Chromium disk could not mount.', 'ready');
            } else if (status) {
                report(...status);
            }
            if (/Kernel panic|Fatal server error/.test(line)) report('Linux could not start the graphical session.');
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
    return {dispose, running: () => vm.is_running(), pause: () => vm.stop(), resume: () => vm.run()};
};
