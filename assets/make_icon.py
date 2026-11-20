"""Generates assets/icon.ico (the exe / window icon). Run: python assets/make_icon.py"""
import os
from PIL import Image, ImageDraw

S = 16  # supersampling: the logo is drawn on a 64-unit grid at 1024 px
RED = (239, 68, 59, 255)
WHITE = (255, 255, 255, 255)


def p(*v):
    return [x * S for x in v]


img = Image.new("RGBA", (64 * S, 64 * S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle(p(0, 0, 64, 64), radius=14 * S, fill=RED)            # tile
d.rounded_rectangle(p(11, 14, 53, 43), radius=4 * S, fill=WHITE)         # screen
d.rectangle(p(29, 43, 35, 49), fill=WHITE)                               # stand
d.rounded_rectangle(p(21, 48, 43, 53), radius=2 * S, fill=WHITE)         # base
arrow = [(25, 19), (25, 37), (29.8, 32.6), (33, 39.6), (36.4, 38), (33.3, 31.2), (39.6, 31.2)]
d.polygon([(x * S, y * S) for x, y in arrow], fill=RED)                  # pointer

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icon.ico")
img.resize((256, 256), Image.LANCZOS).save(out, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
img.resize((256, 256), Image.LANCZOS).save(out.replace(".ico", ".png"))
print("wrote", out)
