#!/usr/bin/env bash
# Copia o app web para android-build/www com os ajustes necessários no APK.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WWW="$ROOT/android-build/www"
rm -rf "$WWW" && mkdir -p "$WWW/assets/pdfjs"

cp "$ROOT/index.html" "$ROOT/manifest.webmanifest" "$WWW/"
cp "$ROOT/android-build/native-tts.js" "$WWW/"
# .mjs pode ser servido com tipo errado pelo servidor interno do Capacitor: usar .js
cp "$ROOT/assets/pdfjs/pdf.min.mjs" "$WWW/assets/pdfjs/pdf.min.js"
cp "$ROOT/assets/pdfjs/pdf.worker.min.mjs" "$WWW/assets/pdfjs/pdf.worker.min.js"

python3 - "$WWW/index.html" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
def must(old, new):
    global s
    if old not in s:
        sys.exit(f'prepare-www: trecho não encontrado: {old!r}')
    s = s.replace(old, new)
must('./assets/pdfjs/pdf.min.mjs', './assets/pdfjs/pdf.min.js')
must('./assets/pdfjs/pdf.worker.min.mjs', './assets/pdfjs/pdf.worker.min.js')
# Service worker não é necessário no APK (os arquivos já estão no aparelho)
must("if('serviceWorker' in navigator)", "if(false)")
# Voz nativa do Android antes do script principal
must('<script type="module">', '<script src="./native-tts.js"></script>\n<script type="module">')
open(p, 'w', encoding='utf-8').write(s)
PY
echo "www pronto em $WWW"
