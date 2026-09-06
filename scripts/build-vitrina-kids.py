#!/usr/bin/env python3
# 🧒 build-vitrina-kids.py — vitrina_kids.json para la sala de envío (ediciones kids vivas con tarjeta+og), con frases ES/EN, colores y música real.
import json, os, re, sys, glob, unicodedata, time
def sg(t): t=unicodedata.normalize("NFKD",t).encode("ascii","ignore").decode().lower(); return re.sub(r"-+","-",re.sub(r"[^a-z0-9]+","-",t)).strip("-")
kids_json = sys.argv[1] if len(sys.argv)>1 else "/home/claude/work/content/contenido_kids.json"
app_dir   = sys.argv[2] if len(sys.argv)>2 else "/home/claude/work/app/public/kids/t"
BASE="https://app.triggui.com/kids/t/"
K=json.load(open(kids_json,encoding="utf-8"))["libros"]; m={sg(b["titulo"]):b for b in K}; m["cenicienta-original"]=next(b for b in K if b["titulo"]=="Cenicienta")
out=[]; vistos=set()
# Orden del catálogo (libros[0] = la más reciente), no alfabético: la sala abre en la última edición kids
for b in K:
    sl=b.get("_slug") or sg(b["titulo"]); d=os.path.join(app_dir,sl)
    if sl in vistos or not (os.path.exists(f"{d}/tarjeta.png") and os.path.exists(f"{d}/og.jpg")): continue
    vistos.add(sl)
    mus=[{k:c.get(k) for k in ("id","cancion","artista","preview","art","link","pie","rol","armonia") if c.get(k) not in (None,"")} for c in ((b.get("_musica") or {}).get("candidatos") or []) if c.get("preview")][:5]
    en_ok=os.path.exists(f"{d}/en/index.html")
    out.append({"slug":sl,"catalogo":"kids","colores":b.get("colores") or [],"textColors":b.get("textColors") or [],
        "es":{"libro":b["titulo"],"autor":b.get("autor",""),"frases":b.get("frases") or [],"url":BASE+sl+"/"},
        "en":{"libro":b["titulo"],"autor":b.get("autor",""),"frases":b.get("frases_en") or [],"url":BASE+sl+"/en/"} if en_ok else None,
        "og":{"es":BASE+sl+"/og.jpg","en":BASE+sl+"/og_en.jpg" if os.path.exists(f"{d}/og_en.jpg") else BASE+sl+"/og.jpg"},
        "full":{"es":BASE+sl+"/tarjeta.png","en":BASE+sl+"/tarjeta_en.png" if os.path.exists(f"{d}/tarjeta_en.png") else BASE+sl+"/tarjeta.png"},
        "musica":mus,"musica_juez":(b.get("_musica") or {}).get("juez","")})
json.dump({"generado":time.strftime("%Y-%m-%d"),"tarjetas":out},open("vitrina_kids.json","w",encoding="utf-8"),ensure_ascii=False,indent=1)
print(f"vitrina_kids.json: {len(out)} ediciones kids · con música {sum(1 for t in out if t['musica'])} · con EN {sum(1 for t in out if t['en'])}")
