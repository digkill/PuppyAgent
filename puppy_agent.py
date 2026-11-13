#!/usr/bin/env python3
"""Puppy Agent — TrueColor terminal mascot (no dependencies)."""
import os
import sys

W, H = 68, 50
pixels = [[None for _ in range(W)] for _ in range(H)]

COL = {
    'ink':      (34, 43, 62),
    'ear':      (191, 113, 62),
    'ear_hi':   (230, 156, 93),
    'ear_shadow':(155, 79, 46),
    'face':     (255, 238, 207),
    'face_hi':  (255, 248, 227),
    'patch':    (207, 132, 75),
    'muzzle':   (255, 250, 233),
    'eye':      (29, 38, 56),
    'white':    (255, 255, 255),
    'nose':     (55, 55, 70),
    'blush':    (245, 166, 145),
    'tongue':   (244, 113, 139),
    'tongue_hi':(255, 172, 180),
}

def ell(cx, cy, rx, ry, color):
    for y in range(max(0, int(cy-ry-1)), min(H, int(cy+ry+2))):
        for x in range(max(0, int(cx-rx-1)), min(W, int(cx+rx+2))):
            if ((x-cx)/rx)**2 + ((y-cy)/ry)**2 <= 1:
                pixels[y][x] = color

def poly(points, color):
    for y in range(H):
        for x in range(W):
            inside = False
            j = len(points)-1
            for i, (xi, yi) in enumerate(points):
                xj, yj = points[j]
                if (yi > y) != (yj > y) and x < (xj-xi)*(y-yi)/(yj-yi)+xi:
                    inside = not inside
                j = i
            if inside:
                pixels[y][x] = color

def dot(x, y, color):
    if 0 <= x < W and 0 <= y < H:
        pixels[y][x] = color

# Floppy ears, tucked behind the round face.
left_outer = [(22,10),(17,6),(11,5),(6,8),(3,15),(2,24),(4,33),(8,37),(13,36),(18,31),(23,18)]
left_inner = [(20,12),(16,9),(12,8),(8,11),(6,17),(5,24),(7,31),(10,33),(14,31),(19,24)]
poly(left_outer, 'ink')
poly(left_inner, 'ear')
poly([(10,12),(8,18),(8,26),(10,30),(14,28),(15,19)], 'ear_hi')
poly([(5,27),(7,34),(11,35),(15,32),(12,31),(8,31)], 'ear_shadow')
flip = lambda pts: [(W-1-x, y) for x,y in pts]
poly(flip(left_outer), 'ink')
poly(flip(left_inner), 'ear')
poly(flip([(10,12),(8,18),(8,26),(10,30),(14,28),(15,19)]), 'ear_hi')
poly(flip([(5,27),(7,34),(11,35),(15,32),(12,31),(8,31)]), 'ear_shadow')

# Puppy head with cream fur, one cinnamon-brown eye patch.
ell(33.5, 24, 22, 21, 'ink')
ell(33.5, 23, 20, 19, 'face')
ell(29, 15, 11, 9, 'face_hi')
ell(44.5, 21, 10, 11, 'patch')
# Tuft of fluffy hair.
poly([(27,6),(30,1),(34,6),(38,2),(39,9),(33,11)], 'ink')
poly([(29,6),(31,3),(34,8),(37,4),(37,10),(32,10)], 'face')

# Sweet eyes, with little white sparkles.
ell(25, 22, 3.6, 4.2, 'ink')
ell(44, 22, 3.6, 4.2, 'ink')
ell(26, 20.6, 1.2, 1.5, 'white')
ell(45, 20.6, 1.2, 1.5, 'white')
# Muzzle and nose.
ell(33.5, 33, 12.5, 9, 'ink')
ell(33.5, 32, 11.5, 8, 'muzzle')
ell(29, 31, 4.2, 2.6, 'face_hi')
ell(38, 31, 4.2, 2.6, 'face_hi')
poly([(29,29),(38,29),(36,33),(34,35),(32,34)], 'nose')
ell(31, 30, 1.5, 0.8, 'white')
# Happy smile and pink tongue.
for x in range(26, 42):
    y = int(34 + 0.048*(x-33.5)**2)
    dot(x, y, 'ink')
for y in range(34, 39):
    dot(34, y, 'ink')
ell(34, 38, 4.3, 3.6, 'ink')
ell(34, 38, 3.4, 2.6, 'tongue')
ell(33, 37, 1.5, 0.8, 'tongue_hi')

# Little rosy cheeks.
ell(19, 29, 2.4, 1.5, 'blush')
ell(49, 29, 2.4, 1.5, 'blush')

RESET = '\033[0m'
def fg(rgb): return f'\033[38;2;{rgb[0]};{rgb[1]};{rgb[2]}m'
def bg(rgb): return f'\033[48;2;{rgb[0]};{rgb[1]};{rgb[2]}m'

def render():
    # Each ▀ displays two vertical TrueColor pixels.
    for y in range(0, H, 2):
        line = []
        for x in range(W):
            top, bottom = pixels[y][x], pixels[y+1][x]
            if top is None and bottom is None:
                line.append(' ')
            elif top is None:
                line.append(fg(COL[bottom]) + '▄' + RESET)
            elif bottom is None:
                line.append(fg(COL[top]) + '▀' + RESET)
            else:
                line.append(fg(COL[top]) + bg(COL[bottom]) + '▀' + RESET)
        print(''.join(line).rstrip())

    title = 'P U P P Y   A G E N T'
    print(' ' * ((W - len(title)) // 2) + fg((35, 195, 241)) + '\033[1m' + title + RESET)
    subtitle = 'your loyal AI coding companion'
    print(' ' * ((W - len(subtitle)) // 2) + fg((153, 163, 181)) + subtitle + RESET)
    status = '● ready to code  ·  woof!'
    print(' ' * ((W - len(status)) // 2) + fg((81, 208, 163)) + status + RESET)

if __name__ == '__main__':
    render()
