"""Bounded first-page extraction; no network, original files stay temporary."""
import json
import os
import resource
import subprocess
import sys
import time
from pathlib import Path

resource.setrlimit(resource.RLIMIT_CPU, (55, 60))
resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024**2, 64 * 1024**2))

def extract():
    import pypdfium2 as pdfium
    path = Path(sys.argv[1])
    deadline = time.monotonic() + 40
    pages = []
    with pdfium.PdfDocument(str(path)) as pdf:
        total = len(pdf)
        for index in range(min(total, 4)):
            if time.monotonic() >= deadline:
                break
            page = pdf[index]
            try:
                textpage = page.get_textpage()
                try:
                    text = textpage.get_text_range()
                finally:
                    textpage.close()
                method = 'pdf_text'
                if len(text.strip()) < 100:
                    width, height = page.get_size()
                    if width <= 0 or height <= 0 or width * height > 4000000:
                        continue
                    bitmap = page.render(scale=min(2.0, 2400 / max(width, height)))
                    image = path.parent / f'page-{index + 1}.png'
                    try:
                        bitmap.to_pil().save(image)
                        result = subprocess.run([os.environ.get('IMA_TESSERACT', '/opt/homebrew/bin/tesseract'), str(image), 'stdout', '-l', 'eng+chi_sim', '--psm', '3'],
                            capture_output=True, timeout=max(1, min(15, deadline - time.monotonic())), check=True,
                            env={**os.environ, 'OMP_THREAD_LIMIT': '1'})
                        text = result.stdout.decode('utf-8', errors='replace')
                        method = 'ocr'
                    except (OSError, subprocess.SubprocessError):
                        text = ''
                    finally:
                        bitmap.close()
                        image.unlink(missing_ok=True)
                if len(text.strip()) >= 80:
                    pages.append({'page': index + 1, 'text': text[:16000], 'method': method})
            finally:
                page.close()
        return {'pages': pages, 'totalPages': total}

try:
    print(json.dumps(extract(), ensure_ascii=False))
except Exception:
    # Parser messages may contain document data or local paths.
    print(json.dumps({'pages': [], 'error': 'PDF_EXTRACTION_FAILED'}))
    sys.exit(1)
