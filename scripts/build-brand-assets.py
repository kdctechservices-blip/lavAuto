#!/usr/bin/env python3
"""
Fabrique les déclinaisons du logo à partir du fichier source.

    pip install Pillow && python3 scripts/build-brand-assets.py

Outil ponctuel : il n'est pas appelé par le build. Il est versionné pour que
les variantes soient reproductibles — si le logo change, on relance ce script
plutôt que de retoucher dix fichiers à la main.

Le source est un JPEG aplati sur fond blanc. Trois problèmes à résoudre :

1. **Le fond blanc.** Il faut le rendre transparent sans manger les dégradés
   argentés de la carrosserie. Un simple seuillage les efface ; on inverse
   donc exactement la composition sur blanc (voir `unmultiply_white`).

2. **Le thème sombre.** Le logo est conçu pour du blanc : ses traits clairs
   ne se lisent que par contraste avec le fond. Rendus transparents, ils
   disparaissent sur bleu nuit. D'où une variante dédiée qui remonte la
   clarté en conservant la teinte (`for_dark`).

3. **Les petites tailles.** Le verrou complet est illisible sous 80 px. On
   décline donc : verrou → emblème → médaillon, du plus riche au plus simple.
"""

import colorsys
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BRAND = os.path.join(ROOT, "public", "brand")
SOURCE = os.path.join(BRAND, "washpilot-logo-source.jpeg")

# Découpes relevées sur le fichier source (1408 x 768).
EMBLEM_BOX = (412, 157, 992, 469)   # voiture + volant
MEDALLION_BOX = (610, 261, 802, 465)  # volant seul : W + flèche
FULL_BOX = (302, 157, 1106, 611)    # verrou complet
TEXT_TOP = 480                      # frontière emblème / texte


def unmultiply_white(img, force_white=False):
    """
    Retire le fond blanc d'un visuel aplati sur blanc.

    Hypothèse : `origine = a*C + (1-a)*255`. On pose `a = (255 - min)/255`,
    ce qui permet de retrouver C exactement. Le rendu est donc identique sur
    fond clair, et correct ailleurs.
    """
    img = img.convert("RGB")
    out = Image.new("RGBA", img.size)
    src, dst = img.load(), out.load()
    for y in range(img.height):
        for x in range(img.width):
            r, g, b = src[x, y]
            mn = min(r, g, b)
            alpha = 255 - mn
            if alpha <= 2:
                dst[x, y] = (0, 0, 0, 0)
            elif force_white:
                dst[x, y] = (255, 255, 255, alpha)
            else:
                k = 255.0 / alpha
                dst[x, y] = (
                    min(255, int((r - mn) * k)),
                    min(255, int((g - mn) * k)),
                    min(255, int((b - mn) * k)),
                    alpha,
                )
    return out


def for_dark(img):
    """
    Décline un visuel pour fond sombre : teinte conservée, clarté remontée,
    alpha relancé par une courbe gamma pour que les traits fins subsistent.
    """
    img = img.convert("RGB")
    out = Image.new("RGBA", img.size)
    src, dst = img.load(), out.load()
    for y in range(img.height):
        for x in range(img.width):
            r, g, b = src[x, y]
            ink = 255 - min(r, g, b)
            if ink <= 2:
                dst[x, y] = (0, 0, 0, 0)
                continue
            alpha = min(255, int(255 * (ink / 255.0) ** 0.55))
            h, l, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
            nr, ng, nb = colorsys.hls_to_rgb(h, 0.70 + 0.24 * l, min(1.0, s * 1.15))
            dst[x, y] = (int(nr * 255), int(ng * 255), int(nb * 255), alpha)
    return out


def fit_height(img, height):
    ratio = height / img.height
    return img.resize((max(1, round(img.width * ratio)), height), Image.LANCZOS)


def square(img, size, pad_ratio=0.04):
    inner = int(size * (1 - 2 * pad_ratio))
    scale = min(inner / img.width, inner / img.height)
    small = img.resize(
        (max(1, int(img.width * scale)), max(1, int(img.height * scale))), Image.LANCZOS
    )
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(small, ((size - small.width) // 2, (size - small.height) // 2), small)
    return canvas


def save(img, name):
    path = os.path.join(BRAND, name)
    img.save(path, optimize=True)
    print(f"  {name:28} {img.width}x{img.height}  {os.path.getsize(path) // 1024} Ko")


def main():
    src = Image.open(SOURCE).convert("RGB")
    print("Déclinaisons du logo :")

    # --- Emblème : voiture + volant -----------------------------------------
    emblem_light = unmultiply_white(src.crop(EMBLEM_BOX))
    emblem_dark = for_dark(src.crop(EMBLEM_BOX))
    save(fit_height(emblem_light, 160), "logo-mark.png")
    save(fit_height(emblem_dark, 160), "logo-mark-dark.png")

    # --- Verrou complet ------------------------------------------------------
    save(fit_height(unmultiply_white(src.crop(FULL_BOX)), 260), "logo-full.png")

    top = for_dark(src.crop((FULL_BOX[0], FULL_BOX[1], FULL_BOX[2], TEXT_TOP)))
    bottom = unmultiply_white(
        src.crop((FULL_BOX[0], TEXT_TOP, FULL_BOX[2], FULL_BOX[3])), force_white=True
    )
    full_dark = Image.new("RGBA", (FULL_BOX[2] - FULL_BOX[0], FULL_BOX[3] - FULL_BOX[1]), (0, 0, 0, 0))
    full_dark.paste(top, (0, 0), top)
    full_dark.paste(bottom, (0, TEXT_TOP - FULL_BOX[1]), bottom)
    save(fit_height(full_dark, 260), "logo-full-dark.png")

    # --- Médaillon : le volant seul -----------------------------------------
    #
    # L'emblème fait 1,86 de large pour 1 de haut. Tassé dans un carré de
    # 32 px, il ne mesure plus que 17 px de haut et devient illisible —
    # vérifié, le volant s'y réduit à une tache. Le médaillon, lui, est
    # naturellement carré et reste net dès 16 px. C'est donc lui qui sert
    # de favicon et d'icône dans les emplacements carrés étroits.
    medallion_light = unmultiply_white(src.crop(MEDALLION_BOX))
    medallion_dark = for_dark(src.crop(MEDALLION_BOX))
    save(square(medallion_light, 128, pad_ratio=0.02), "logo-badge.png")
    save(square(medallion_dark, 128, pad_ratio=0.02), "logo-badge-dark.png")

    # --- Icônes carrées (favicon, écran d'accueil mobile) --------------------
    for size in (32, 180, 192, 512):
        save(square(medallion_light, size, pad_ratio=0.02), f"icon-{size}.png")
    save(square(medallion_dark, 32, pad_ratio=0.02), "icon-32-dark.png")

    # --- Image de partage social --------------------------------------------
    build_og(full_dark)


def build_og(lockup_dark):
    """
    Vignette affichée quand un lien vers l'application est partagé.

    On réemploie le verrou plutôt que de retaper « WashPilot CI » avec une
    police approchante : la typographie du logo est ainsi exacte, et la
    vignette suit automatiquement tout changement de logo.

    Dimensions imposées par les balises Open Graph de `index.html`.
    """
    from PIL import ImageDraw

    W, H = 1200, 630
    og = Image.new("RGB", (W, H), (7, 26, 54))

    # Halo radial discret : évite l'aplati d'un fond parfaitement uni.
    glow = Image.new("L", (W, H), 0)
    gd = ImageDraw.Draw(glow)
    for i in range(36, 0, -1):
        gd.ellipse(
            [W // 2 - i * 22, H // 2 - i * 14, W // 2 + i * 22, H // 2 + i * 14],
            fill=int(42 * (1 - i / 36)),
        )
    og.paste(Image.new("RGB", (W, H), (22, 60, 112)), (0, 0), glow)

    lock = fit_height(lockup_dark, 300)
    og.paste(lock, ((W - lock.width) // 2, 150), lock)

    bar = Image.new("RGB", (160, 4), (74, 160, 92))
    og.paste(bar, ((W - 160) // 2, 486))

    path = os.path.join(os.path.dirname(BRAND), "og-image.png")
    og.save(path, optimize=True)
    print(f"  {'og-image.png':28} {W}x{H}  {os.path.getsize(path) // 1024} Ko")


if __name__ == "__main__":
    main()
