#!/usr/bin/env python3
"""Generate 15 PRANA logo concepts as PNGs + a labeled contact sheet.
Theme: dark-blue field (space/ether) with a luminous lighter-blue core (the creative spark).
Pure-Pillow raster (no SVG renderer needed). Concept SVG comes after the user picks one."""
import math, os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

S = 480                      # tile size
OUT = os.path.dirname(os.path.abspath(__file__))
os.makedirs(OUT, exist_ok=True)

# palette
EDGE   = (4, 7, 20)          # near-black indigo edge
FIELD  = (10, 20, 56)        # deep field blue
MID    = (30, 70, 150)
CORE   = (130, 210, 255)     # Prana light-blue
HOT    = (230, 248, 255)     # hot center

def lerp(a, b, t): return tuple(int(a[i] + (b[i]-a[i])*t) for i in range(3))

def radial_bg(draw, img, c_edge=EDGE, c_field=FIELD, cx=None, cy=None, r=None):
    cx = cx or S//2; cy = cy or S//2; r = r or int(S*0.72)
    for i in range(r, 0, -1):
        t = i / r
        col = lerp(c_field, c_edge, t)
        draw.ellipse([cx-i, cy-i, cx+i, cy+i], fill=col)

def glow(size, color=CORE, hot=HOT, radius=0.32, intensity=1.0):
    """Return an additive RGBA glow image with a hot center."""
    g = Image.new("RGBA", (size, size), (0,0,0,0))
    d = ImageDraw.Draw(g)
    cx = cy = size//2
    R = int(size*radius)
    for i in range(R, 0, -1):
        t = i / R
        col = lerp(hot, color, min(1.0, t*1.3))
        a = int(255 * (1-t)**1.7 * intensity)
        d.ellipse([cx-i, cy-i, cx+i, cy+i], fill=(col[0], col[1], col[2], a))
    return g.filter(ImageFilter.GaussianBlur(size*0.012))

def base():
    img = Image.new("RGBA", (S, S), (0,0,0,0))
    radial_bg(ImageDraw.Draw(img), img)
    return img

def add_glow(img, **kw):
    g = glow(S, **kw)
    return Image.alpha_composite(img, g)

def ring(img, r, width=4, color=CORE, alpha=220):
    o = Image.new("RGBA", (S,S), (0,0,0,0))
    d = ImageDraw.Draw(o)
    c = S//2
    d.ellipse([c-r, c-r, c+r, c+r], outline=(color[0],color[1],color[2],alpha), width=width)
    return Image.alpha_composite(img, o)

def spiral(img, turns=2.4, color=CORE, points=400, rmax=0.42, width=5, alpha=210):
    o = Image.new("RGBA", (S,S), (0,0,0,0))
    d = ImageDraw.Draw(o)
    c = S//2; pts=[]
    for i in range(points):
        t = i/points
        ang = t*turns*2*math.pi
        rad = t*rmax*S
        pts.append((c+rad*math.cos(ang), c+rad*math.sin(ang)))
    for i in range(len(pts)-1):
        a = int(alpha*(i/points))
        d.line([pts[i], pts[i+1]], fill=(color[0],color[1],color[2],a), width=width)
    return Image.alpha_composite(img, o.filter(ImageFilter.GaussianBlur(1.2)))

def rays(img, n=12, color=CORE, rin=0.16, rout=0.46, width=4, alpha=180):
    o = Image.new("RGBA", (S,S), (0,0,0,0))
    d = ImageDraw.Draw(o); c=S//2
    for k in range(n):
        ang = k*2*math.pi/n
        x1=c+rin*S*math.cos(ang); y1=c+rin*S*math.sin(ang)
        x2=c+rout*S*math.cos(ang); y2=c+rout*S*math.sin(ang)
        d.line([(x1,y1),(x2,y2)], fill=(color[0],color[1],color[2],alpha), width=width)
    return Image.alpha_composite(img, o.filter(ImageFilter.GaussianBlur(1.0)))

def polygon(img, sides, r=0.4, rot=0, color=CORE, width=5, alpha=220):
    o=Image.new("RGBA",(S,S),(0,0,0,0)); d=ImageDraw.Draw(o); c=S//2; pts=[]
    for k in range(sides):
        ang=rot+k*2*math.pi/sides
        pts.append((c+r*S*math.cos(ang), c+r*S*math.sin(ang)))
    d.polygon(pts, outline=(color[0],color[1],color[2],alpha));
    for i in range(len(pts)):
        d.line([pts[i], pts[(i+1)%len(pts)]], fill=(color[0],color[1],color[2],alpha), width=width)
    return Image.alpha_composite(img, o)

def petals(img, n=8, color=CORE, alpha=150):
    o=Image.new("RGBA",(S,S),(0,0,0,0)); d=ImageDraw.Draw(o); c=S//2
    for k in range(n):
        ang=k*2*math.pi/n
        ex=c+0.22*S*math.cos(ang); ey=c+0.22*S*math.sin(ang)
        d.ellipse([ex-S*0.13, ey-S*0.05, ex+S*0.13, ey+S*0.05], outline=(color[0],color[1],color[2],alpha), width=3)
    return Image.alpha_composite(img, o.filter(ImageFilter.GaussianBlur(0.8)))

def star4(img, color=HOT, alpha=230):
    o=Image.new("RGBA",(S,S),(0,0,0,0)); d=ImageDraw.Draw(o); c=S//2
    for ang in [0, math.pi/2]:
        for s in (1,-1):
            x=c+s*0.45*S*math.cos(ang); y=c+s*0.45*S*math.sin(ang)
            d.line([(c,c),(x,y)], fill=(color[0],color[1],color[2],alpha), width=6)
    return Image.alpha_composite(img, o.filter(ImageFilter.GaussianBlur(2.0)))

concepts = []
def cz(name, fn): concepts.append((name, fn))

cz("01 orb",            lambda: add_glow(base()))
cz("02 orb+ring",       lambda: ring(add_glow(base()), int(S*0.42)))
cz("03 vortex",         lambda: spiral(add_glow(base(), radius=0.26)))
cz("04 surya rays",     lambda: rays(add_glow(base(), radius=0.22)))
cz("05 hexagon",        lambda: polygon(add_glow(base()), 6, rot=math.pi/6))
cz("06 coin double",    lambda: ring(ring(add_glow(base()), int(S*0.44),6), int(S*0.36),2))
cz("07 spiral galaxy",  lambda: spiral(add_glow(base(), radius=0.20), turns=3.2, rmax=0.46))
cz("08 lotus",          lambda: petals(add_glow(base(), radius=0.18)))
cz("09 aura rings",     lambda: ring(ring(ring(add_glow(base(),radius=0.2),int(S*0.3),3,alpha=120),int(S*0.38),3,alpha=90),int(S*0.45),3,alpha=60))
cz("10 diamond",        lambda: polygon(add_glow(base()), 4, r=0.42, rot=math.pi/4))
cz("11 spark star",     lambda: star4(add_glow(base(), radius=0.2)))
cz("12 triangle",       lambda: polygon(add_glow(base()), 3, r=0.44, rot=-math.pi/2))
cz("13 rays+ring",      lambda: ring(rays(add_glow(base(),radius=0.18), n=24, width=2, alpha=120), int(S*0.42)))
cz("14 dbl-spiral",     lambda: spiral(spiral(add_glow(base(),radius=0.16), turns=1.6, rmax=0.4), turns=1.6, rmax=-0.4))
cz("15 halo dot",       lambda: ring(add_glow(base(), radius=0.10, intensity=1.2), int(S*0.34), 8, alpha=160))

saved=[]
for name, fn in concepts:
    img = fn().convert("RGB")
    fn_path = os.path.join(OUT, f"prana-{name.split()[0]}.png")
    img.save(fn_path)
    saved.append((name, fn_path, img))

# contact sheet 5x3
cols, rows = 5, 3
pad, label_h = 16, 28
tw = S//2
cell = tw + pad
sheet = Image.new("RGB", (cols*cell+pad, rows*(cell+label_h)+pad), (8,10,22))
sd = ImageDraw.Draw(sheet)
try: font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 18)
except: font = ImageFont.load_default()
for idx,(name,_,img) in enumerate(saved):
    r,c = divmod(idx, cols)
    x = pad + c*cell; y = pad + r*(cell+label_h)
    sheet.paste(img.resize((tw,tw)), (x,y))
    sd.text((x+4, y+tw+4), name, fill=(170,210,255), font=font)
sheet_path = os.path.join(OUT, "prana-logo-contact-sheet.png")
sheet.save(sheet_path)
print("wrote", len(saved), "logos +", sheet_path)
