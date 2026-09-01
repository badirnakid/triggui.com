#!/usr/bin/env python3
# 🎧 enriquecer-vitrina-musica.py — añade `musica` (candidatas reales del resolutor) a cada tarjeta de vitrina.json.
# Idempotente: sobreescribe solo la clave `musica`. Fuente: contenido.json + contenido_manual.json de triggui-content.
# Uso:  python3 scripts/enriquecer-vitrina-musica.py [ruta_contenido.json] [ruta_manual.json]
#       (sin argumentos lee ambos desde raw.githubusercontent.com)
import json, re, sys, unicodedata, urllib.request, time

RAW = "https://raw.githubusercontent.com/badirnakid/triggui-content/main/"
CAMPOS = ("id", "cancion", "artista", "album", "preview", "art", "link", "pie", "rol", "armonia", "canon")

def slugify(t):
    t = unicodedata.normalize("NFKD", t).encode("ascii", "ignore").decode().lower()
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", t)).strip("-")

def carga(ruta_o_nombre):
    if ruta_o_nombre.startswith("http"):
        with urllib.request.urlopen(ruta_o_nombre + "?ts=" + str(int(time.time())), timeout=60) as r:
            return json.load(r)
    return json.load(open(ruta_o_nombre, encoding="utf-8"))

def main():
    src_a = sys.argv[1] if len(sys.argv) > 1 else RAW + "contenido.json"
    src_m = sys.argv[2] if len(sys.argv) > 2 else RAW + "contenido_manual.json"
    libros = carga(src_a)["libros"] + carga(src_m)["libros"]
    por_slug = {}
    for b in libros:
        por_slug.setdefault(slugify(b.get("titulo", "")), b)
    vit = json.load(open("vitrina.json", encoding="utf-8"))
    con = sin = 0
    for t in vit.get("tarjetas", []):
        b = por_slug.get(t.get("slug", ""))
        m = (b or {}).get("_musica") or {}
        cands = [c for c in (m.get("candidatos") or []) if c.get("preview")]
        if cands:
            t["musica"] = [{k: c.get(k) for k in CAMPOS if c.get(k) not in (None, "")} for c in cands[:5]]
            t["musica_juez"] = m.get("juez", "")
            con += 1
        else:
            t.pop("musica", None); t.pop("musica_juez", None); sin += 1
    vit["musica_enriquecida"] = time.strftime("%Y-%m-%d")
    json.dump(vit, open("vitrina.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"vitrina.json: {con} tarjetas con música · {sin} sin música")

if __name__ == "__main__":
    main()
