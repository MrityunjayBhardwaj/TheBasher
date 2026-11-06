# Blender oracle for blending two transforms (#1811): a Copy Transforms constraint at influence
# 0, .25, .5, .75 and 1, whose whole matrices the Blend Transforms wiring must reproduce.
# Run: blender --background --factory-startup --python scripts/blender-transform-blend-oracle.py -- out.json
import bpy, math, json, sys
from mathutils import Euler
d=math.radians
def fresh():
    for o in list(bpy.data.objects): bpy.data.objects.remove(o)
def e(n,loc=(0,0,0),rot=(0,0,0),s=(1,1,1),par=None):
    o=bpy.data.objects.new(n,None); o.location=loc; o.rotation_euler=[d(x) for x in rot]; o.scale=s; bpy.context.scene.collection.objects.link(o)
    if par: o.parent=par
    return o
CASES={
 'plain':lambda:(e('A',(1,2,3),(30,10,5),(1,2,1)),e('B',(-1,0,4),(-20,50,9),(2,1,.5))),
 'short-way':lambda:(e('A',rot=(0,0,170)),e('B',rot=(0,0,-170))),
 'spin-350':lambda:(e('A'),e('B',rot=(0,0,350))),
 'mirror-x':lambda:(e('A'),e('B',s=(-1,1,1))),
 'mirror-rotated':lambda:(e('A',rot=(0,0,20)),e('B',(1,0,0),(40,0,0),(1,-2,1))),
 'zero-scale':lambda:(e('A'),e('B',rot=(0,0,90),s=(0,0,0))),
 'flat-x':lambda:(e('A',rot=(0,30,0)),e('B',rot=(0,0,60),s=(0,1,1))),
 'line-z':lambda:(e('A',rot=(0,30,0)),e('B',rot=(50,0,60),s=(0,0,2))),
 'shear':lambda:(e('A',rot=(0,0,30),par=e('P',rot=(0,0,45),s=(1,3,1))),e('B',(2,0,0))),
 'shear-mirror':lambda:(e('A',rot=(0,0,30),par=e('P',rot=(0,0,45),s=(-1,3,1))),e('B',(2,0,0),(0,40,0),(2,2,.5))),
 'shear-both':lambda:(e('A',rot=(0,0,30),par=e('P',rot=(0,0,45),s=(1,3,1))),e('B',rot=(0,25,0),par=e('Q',rot=(20,0,0),s=(2,1,1)))),
}
out={'version':bpy.app.version_string,'cases':{}}
for name,mk in CASES.items():
    fresh(); A,B=mk()
    c=A.constraints.new('COPY_TRANSFORMS'); c.target=B
    rows={}
    for f in (0,.25,.5,.75,1):
        c.influence=f; bpy.context.view_layer.update()
        rows[str(f)]=[x for col in A.matrix_world.col for x in col]
    bpy.context.view_layer.update()
    out['cases'][name]={'b':[x for col in B.matrix_world.col for x in col],'rows':rows}
json.dump(out,open(sys.argv[sys.argv.index('--')+1],'w'))
print("DONE")
