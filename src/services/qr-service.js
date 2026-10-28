import QRCode from 'qrcode';

export class QrService {
  async createDepositAddressPng(depositAddress) {
    const value = String(depositAddress ?? '');
    if (value.length < 3 || value.length > 500) throw new Error('Deposit address cannot be encoded as a QR code.');
    return QRCode.toBuffer(value, {
      type: 'png',
      errorCorrectionLevel: 'M',
      width: 320,
      margin: 2,
      color: {
        dark: '#111111FF',
        light: '#FFFFFFFF',
      },
    });
  }
}
