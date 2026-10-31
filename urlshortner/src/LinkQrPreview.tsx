import { useMemo, useState } from 'react'
import { Download, LoaderCircle, Palette } from 'lucide-react'
import { Link } from 'react-router-dom'
import { DEFAULT_DESIGN, qrSvg } from './qr'
import { exportQr, saveBlob } from './qrExport'
import { displayShortUrl } from './links'

export default function LinkQrPreview({
  code,
  shortUrl,
  notify,
}: {
  code: string
  shortUrl: string
  notify: (message: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const preview = useMemo(
    () => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvg(shortUrl, DEFAULT_DESIGN, 132))}`,
    [shortUrl],
  )

  async function download() {
    setBusy(true)
    try {
      const { name, blob } = await exportQr('png', shortUrl, DEFAULT_DESIGN, {
        pixels: 1024,
        pdf: { sizeCm: 5, page: 'fit', caption: true },
        code,
        caption: displayShortUrl(shortUrl),
      })
      saveBlob(name, blob)
      notify('QR code downloaded.')
    } catch {
      notify('The QR code could not be generated.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel link-qr" aria-labelledby="link-qr-heading">
      <img src={preview} width={132} height={132} alt={`QR code for ${displayShortUrl(shortUrl)}`} />
      <div className="link-qr-body">
        <h2 id="link-qr-heading">QR code</h2>
        <p className="meta">
          Scans straight to {displayShortUrl(shortUrl)}. Restyle it, add a logo, or export SVG,
          PDF and more in the studio.
        </p>
        <div className="link-qr-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void download()}>
            {busy ? <LoaderCircle size={15} className="spin" /> : <Download size={15} />}
            Download PNG
          </button>
          <Link className="primary-button" to={`/qr?code=${encodeURIComponent(code)}`}>
            <Palette size={15} /> Customize
          </Link>
        </div>
      </div>
    </section>
  )
}
