import { cleanToken, TOKEN_KEY } from '../lib/protocol.js';

AppSettingsPage({
  build(props) {
    const storage = props.settingsStorage;
    const token = cleanToken(storage.getItem(TOKEN_KEY)), saved = !!token;
    const error = storage.getItem('tokenInputError') || '';
    const paragraph = (text, style = {}) => Text({ paragraph: true, style: { margin: '0 0 14px', ...style } }, text);
    return View({ style: { padding: '24px', fontSize: '17px', lineHeight: '1.5', background: '#ffffff', color: '#182b3a' } }, [
      paragraph('Faceclaw Remote', { fontSize: '28px', fontWeight: '700', marginBottom: '6px' }),
      paragraph('Connect this watch to Faceclaw on the same Android phone.', { color: '#526372' }),
      View({ style: { border: '2px solid #1766be', borderRadius: '16px', padding: '20px', margin: '22px 0' } }, [
        paragraph('Faceclaw input token', { fontSize: '22px', fontWeight: '700', marginBottom: '10px' }),
        paragraph(saved ? 'Token saved' : 'Input token needed', { color: saved ? '#166534' : '#854d0e', background: saved ? '#dcfce7' : '#fef3c7', borderRadius: '8px', padding: '8px 12px', fontWeight: '600' }),
        paragraph('In Faceclaw, open Settings → API Keys → Input tokens. Create a token with “Provide input”, then copy it.'),
        TextInput({
          label: saved ? 'Change input token →' : 'Enter input token →', value: token,
          placeholder: 'Paste the complete fc1_ token',
          labelStyle: { display: 'block', boxSizing: 'border-box', width: '100%', padding: '16px 10px', fontSize: '20px', fontWeight: '700', lineHeight: '1.3', textAlign: 'center', background: '#1766be', color: '#ffffff', borderRadius: '10px' },
          subStyle: { display: 'none' },
          onChange: value => {
            const next = cleanToken(value);
            if (!next) { storage.setItem('tokenInputError', 'Not saved. Paste the complete fc1_ token from Faceclaw.' + (saved ? ' Your saved token is unchanged.' : '')); return; }
            storage.setItem('tokenInputError', ''); storage.setItem(TOKEN_KEY, next);
          },
        }),
        paragraph('Tap the blue button, paste your token, then confirm.', { marginTop: '12px', marginBottom: '0', color: '#526372', fontSize: '15px' }),
        ...(error ? [paragraph(error, { color: '#a32620', marginTop: '14px', marginBottom: '0' })] : []),
      ]),
      paragraph('Next: open Faceclaw Remote on the watch.', { fontWeight: '600' }),
      paragraph('Allow Zepp and Faceclaw to run in the background, including when the phone is locked. Keep Bluetooth on.', { color: '#526372' }),
      paragraph('Uses only this phone: 127.0.0.1:8791. No extra relay app, Wi-Fi server, or USB connection is needed.', { color: '#526372', fontSize: '15px' }),
    ]);
  },
});
