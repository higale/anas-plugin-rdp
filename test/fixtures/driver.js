import { init, Backend } from '/rdp.js';
import '/desktop.js';

await init('OFF');
const element = document.createElement('iron-remote-desktop');
element.setAttribute('scale', 'fit');
element.setAttribute('verbose', 'false');
element.addEventListener('ready', event => {
  const ui = event.detail.irgUserInteraction;
  ui.setEnableClipboard(false);
  ui.setEnableAutoClipboard(false);
  window.rdpTest = {
    async connect({ host, port, username, password, domain, proxy, token }) {
      const destination = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
      const config = ui.configBuilder().withUsername(username).withPassword(password)
        .withDestination(destination).withProxyAddress(proxy).withAuthToken(token)
        .withServerDomain(domain || '').withDesktopSize(new Backend.DesktopSize(1024, 768)).build();
      try {
        const session = await ui.connect(config);
        ui.setVisibility(true);
        window.rdpTest.running = session.run().then(() => { window.rdpTest.ended = true; }, () => { window.rdpTest.failed = true; });
        return { connected: true };
      }
      catch (error) { return { connected: false, kind: typeof error.kind === 'function' ? error.kind() : 'unknown' }; }
    },
    disconnect: () => ui.shutdown(),
    pixels() {
      const canvas = element.shadowRoot.querySelector('canvas');
      if (!canvas?.width || !canvas.height) return 0;
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      const colors = new Set();
      for (let i = 0; i < pixels.length; i += 400) colors.add(`${pixels[i]},${pixels[i+1]},${pixels[i+2]}`);
      return colors.size;
    },
  };
});
element.module = Backend;
document.body.append(element);
