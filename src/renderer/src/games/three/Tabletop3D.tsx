// <Tabletop3D>: the ONE shared R3F tabletop renderer (spec §3D).
//
// Declarative contract: `pieces` is the source of truth; prop diffs drive the
// animations (position change → ease-out slide, removal → capture lift-fade,
// two-tone color change → flip). The imperative handle (animateMove/Capture/
// Flip) pre-echoes the same motions for owners that want them before state
// lands. Interaction only PROPOSES (onSquareClick/onPieceDrag): rules stay
// with the owner; an unanswered drop glides back home.
//
// No network: environment lighting is three's procedural RoomEnvironment, all
// textures are games-art (runtime, optional) or canvas-procedural.

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type JSX,
  type Ref
} from 'react'
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { ContactShadows } from '@react-three/drei'
import type {
  TabletopPos,
  TabletopProvider,
  Tabletop3DHandle,
  Tabletop3DProps
} from './types'
import { createLayout, type TabletopLayout } from './layout'
import { MotionController, type CaptureGhost } from './animation'
import { detectWebGL } from './webgl'
import { getTabletopProvider } from './providers'
import { BoardPlane } from './Boards'
import { GoStones } from './pieces/GoStones'
import { Discs } from './pieces/Discs'
import { Wedges } from './pieces/Wedges'
import { Tokens } from './pieces/Tokens'
import { ChessSetSystem } from './pieces/ChessSetPieces'
import { hashString, makeFeltCanvas, canvasTexture } from './procedural'
import { useArtPbr } from './materialHooks'
import { CameraRig } from './CameraRig'
import { TheaterRig } from './TheaterRig'
import type { PreparedPiece } from './pieces/common'

const DRAG_LIFT = 0.55

interface SceneApi {
  capture(id: string): void
  flip(id: string): void
}

function samePos(a: TabletopPos, b: TabletopPos): boolean {
  return a.file === b.file && a.rank === b.rank
}

function flipAngleFor(provider: TabletopProvider, color: 'white' | 'black'): number {
  if (provider.system === 'disc' && provider.disc?.twoTone) return color === 'black' ? Math.PI : 0
  return 0
}

/** Procedural room reflections, PBR speculars without any HDR download. */
function SceneEnv(): null {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl)
    const rt = pmrem.fromScene(new RoomEnvironment(), 0.04)
    scene.environment = rt.texture
    scene.environmentIntensity = 0.5
    return () => {
      scene.environment = null
      rt.dispose()
      pmrem.dispose()
    }
  }, [gl, scene])
  return null
}

/** Table under the board: felt (art or procedural) + soft edge vignette. */
function Table({ span, artBase }: { span: number; artBase: string | null | undefined }): JSX.Element {
  const felt = useArtPbr('felt', artBase, [3, 3])
  const fallback = useMemo(() => {
    const tex = canvasTexture(makeFeltCanvas(512, '#2b3a31', 5))
    tex.repeat.set(3, 3)
    tex.wrapS = THREE.RepeatWrapping
    tex.wrapT = THREE.RepeatWrapping
    return tex
  }, [])
  const vignette = useMemo(() => {
    const size = 512
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')!
    const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.18, size / 2, size / 2, size * 0.5)
    g.addColorStop(0, 'rgba(0,0,0,0)')
    g.addColorStop(0.72, 'rgba(0,0,0,0.28)')
    g.addColorStop(1, 'rgba(0,0,0,0.82)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, size, size)
    return canvasTexture(canvas)
  }, [])
  const side = span * 7
  // Fresh material whenever the felt maps land. Late map/normalMap adds on a
  // live material would silently skip the shader recompile (see FrameMaterial).
  const feltMaterial = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        map: felt?.map ?? fallback,
        normalMap: felt?.normalMap ?? null,
        roughnessMap: felt?.roughnessMap ?? null,
        color: felt ? '#5c6f60' : '#ffffff',
        roughness: 0.95,
        metalness: 0,
        envMapIntensity: 0.25
      }),
    [felt, fallback]
  )
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[0, -0.003, 0]} receiveShadow material={feltMaterial}>
        <planeGeometry args={[side, side]} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.001, 0]} raycast={() => null}>
        <planeGeometry args={[side, side]} />
        <meshBasicMaterial map={vignette} transparent depthWrite={false} />
      </mesh>
    </group>
  )
}

/** Warm key + cool fill + hemisphere bounce. */
function Lights({ span }: { span: number }): JSX.Element {
  const target = useMemo(() => new THREE.Object3D(), [])
  return (
    <group>
      <hemisphereLight args={['#fff2df', '#463d2f', 0.5]} />
      <directionalLight
        color="#ffdfb0"
        intensity={2.4}
        position={[span * 0.55, span * 1.25, span * 0.7]}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-span}
        shadow-camera-right={span}
        shadow-camera-top={span}
        shadow-camera-bottom={-span}
        shadow-camera-near={0.5}
        shadow-camera-far={span * 5}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
        target={target}
      />
      <directionalLight color="#b9d0ff" intensity={0.45} position={[-span, span * 0.5, -span * 0.8]} />
      <primitive object={target} position={[0, 0, 0]} />
    </group>
  )
}

/** Hover marker per layout kind (never raycastable). */
function HoverMarker({
  layout,
  pos
}: {
  layout: TabletopLayout
  pos: TabletopPos
}): JSX.Element {
  const world = useMemo(() => layout.worldOf(pos), [layout, pos])
  if (layout.shape.layout === 'holes') {
    return (
      <group raycast={() => null}>
        <mesh position={[world.x, 0.34 + layout.frameHeight / 2 + 0.1, 0.2]} raycast={() => null}>
          <planeGeometry args={[0.86, layout.frameHeight]} />
          <meshBasicMaterial color="#ffd257" transparent opacity={0.08} depthWrite={false} />
        </mesh>
        <mesh
          rotation-x={Math.PI / 2}
          position={[world.x, 0.34 + layout.frameHeight + 0.35, 0]}
          raycast={() => null}
        >
          <ringGeometry args={[0.3, 0.44, 48]} />
          <meshBasicMaterial color="#ffd257" transparent opacity={0.7} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      </group>
    )
  }
  if (layout.shape.layout === 'intersections') {
    return (
      <mesh
        rotation-x={-Math.PI / 2}
        position={[world.x, layout.boardTopY + 0.006, world.z]}
        raycast={() => null}
      >
        <ringGeometry args={[0.3, 0.42, 48]} />
        <meshBasicMaterial color="#f6c945" transparent opacity={0.75} depthWrite={false} />
      </mesh>
    )
  }
  return (
    <mesh
      rotation-x={-Math.PI / 2}
      position={[world.x, layout.boardTopY + 0.006, world.z]}
      raycast={() => null}
    >
      <planeGeometry args={[0.94, 0.94]} />
      <meshBasicMaterial color="#f6c945" transparent opacity={0.3} depthWrite={false} />
    </mesh>
  )
}

interface SceneProps {
  layout: TabletopLayout
  provider: TabletopProvider
  pieces: Tabletop3DProps['pieces']
  interactive: boolean
  topDown: boolean
  artBase: string | null | undefined
  onSquareClick?: Tabletop3DProps['onSquareClick']
  onPieceDrag?: Tabletop3DProps['onPieceDrag']
  theater?: Tabletop3DProps['theater']
  controller: MotionController
  apiRef: { current: SceneApi | null }
}

function TabletopScene({
  layout,
  provider,
  pieces,
  interactive,
  topDown,
  artBase,
  onSquareClick,
  onPieceDrag,
  theater,
  controller,
  apiRef
}: SceneProps): JSX.Element {
  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera)
  const upright = layout.shape.layout === 'holes'
  const span = Math.max(layout.width, upright ? layout.frameHeight + 1 : layout.depth)

  // ---- prepared pieces -----------------------------------------------------
  const prepared: PreparedPiece[] = useMemo(
    () =>
      pieces.map((p) => ({
        id: p.id,
        type: p.type,
        color: p.color,
        home: layout.worldOf(p.pos),
        seed: hashString(p.id)
      })),
    [pieces, layout]
  )
  const piecesById = useMemo(() => new Map(pieces.map((p) => [p.id, p])), [pieces])

  // ---- ghosts + prop-diff driven animation ----------------------------------
  const [ghosts, setGhosts] = useState<CaptureGhost[]>([])
  const clockRef = useRef(0)
  useFrame(({ clock }) => {
    clockRef.current = clock.elapsedTime
    controller.tick(clock.elapsedTime)
  }, -1)

  const prevPieces = useRef<Map<string, { type: string; color: 'white' | 'black' }>>(new Map())
  const firstSync = useRef(true)
  // Layout identity: when it changes (OTB orientation flip mirrors the world)
  // existing pieces TELEPORT to their re-homed spots instead of sliding.
  const prevLayout = useRef(layout)

  const spawnGhost = useCallback(
    (id: string): void => {
      const pose = controller.pose(id)
      const info = prevPieces.current.get(id)
      if (!pose || !info) return
      const g: CaptureGhost = {
        id: `${id}@${clockRef.current.toFixed(3)}`,
        type: info.type,
        color: info.color,
        position: pose.position.clone(),
        flipAngle: pose.flipAngle,
        bornAt: clockRef.current
      }
      controller.remove(id)
      setGhosts((gs) => [...gs.slice(-24), g])
    },
    [controller]
  )
  const removeGhost = useCallback((gid: string): void => {
    setGhosts((gs) => gs.filter((g) => g.id !== gid))
  }, [])

  useEffect(() => {
    const first = firstSync.current
    firstSync.current = false
    const layoutChanged = prevLayout.current !== layout
    prevLayout.current = layout
    const seen = new Set<string>()
    for (const p of prepared) {
      seen.add(p.id)
      const angle = flipAngleFor(provider, piecesById.get(p.id)?.color ?? p.color)
      if (!controller.has(p.id)) {
        if (upright && !first) {
          // Connect-four style entry: materialize above the frame, drop in.
          const top = p.home.clone()
          top.y = 0.34 + layout.frameHeight + 0.7
          controller.ensure(p.id, top, angle, false)
          controller.moveTo(p.id, p.home)
        } else {
          controller.ensure(p.id, p.home, angle, !first)
        }
      } else if (layoutChanged) {
        // Orientation flip re-homed the whole board: instant repaint, no slides.
        controller.teleport(p.id, p.home)
        controller.setFlip(p.id, angle, false)
      } else {
        controller.ensure(p.id, p.home, angle, false)
        controller.setFlip(p.id, angle, !first)
      }
    }
    for (const id of [...controller.ids()]) {
      if (!seen.has(id)) spawnGhost(id)
    }
    prevPieces.current = new Map(prepared.map((p) => [p.id, { type: p.type, color: p.color }]))
  }, [prepared, provider, controller, piecesById, spawnGhost, layout])

  // Imperative handle backing.
  useEffect(() => {
    apiRef.current = {
      capture: (id) => spawnGhost(id),
      flip: (id) => controller.setFlip(id, controller.flipOf(id) < Math.PI / 2 ? Math.PI : 0, true)
    }
    return () => {
      apiRef.current = null
    }
  }, [apiRef, controller, spawnGhost])

  // ---- hover + drag interaction ---------------------------------------------
  const [hoverPos, setHoverPos] = useState<TabletopPos | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const dragInfo = useRef<{ id: string; from: TabletopPos } | null>(null)

  const setHover = useCallback((pos: TabletopPos | null): void => {
    setHoverPos((cur) => {
      if (cur === pos) return cur
      if (cur && pos && samePos(cur, pos)) return cur
      return pos
    })
  }, [])

  const onPieceOver = useCallback(
    (id: string): void => {
      if (!interactive || !onPieceDrag || dragInfo.current || upright) return
      controller.setLift(id, true)
      gl.domElement.style.cursor = 'grab'
    },
    [interactive, onPieceDrag, controller, gl, upright]
  )
  const onPieceOut = useCallback(
    (id: string): void => {
      controller.setLift(id, false)
      if (!dragInfo.current) gl.domElement.style.cursor = ''
    },
    [controller, gl]
  )
  const onPieceDown = useCallback(
    (id: string, e: ThreeEvent<PointerEvent>): void => {
      // Upright boards (connect four) are click-to-drop, not drag.
      if (!interactive || !onPieceDrag || dragInfo.current || upright) return
      const piece = piecesById.get(id)
      if (!piece) return
      e.stopPropagation()
      dragInfo.current = { id, from: piece.pos }
      controller.setLift(id, false)
      gl.domElement.style.cursor = 'grabbing'
      setDragId(id)
    },
    [interactive, onPieceDrag, piecesById, controller, gl, upright]
  )

  useEffect(() => {
    if (!dragId) return undefined
    const el = gl.domElement
    const ray = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    const hit = new THREE.Vector3()
    const plane = upright
      ? new THREE.Plane(new THREE.Vector3(0, 0, 1), -0.9)
      : new THREE.Plane(new THREE.Vector3(0, 1, 0), -(layout.boardTopY + DRAG_LIFT))
    const project = (ev: PointerEvent): boolean => {
      const rect = el.getBoundingClientRect()
      ndc.set(
        ((ev.clientX - rect.left) / rect.width) * 2 - 1,
        -(((ev.clientY - rect.top) / rect.height) * 2 - 1)
      )
      ray.setFromCamera(ndc, camera)
      return ray.ray.intersectPlane(plane, hit) !== null
    }
    const onMove = (ev: PointerEvent): void => {
      if (!project(ev)) return
      controller.setDragPoint(dragId, hit)
      setHover(layout.posAt(hit))
    }
    const onUp = (ev: PointerEvent): void => {
      const info = dragInfo.current
      dragInfo.current = null
      setDragId(null)
      setHover(null)
      gl.domElement.style.cursor = ''
      if (!info) return
      controller.setDragPoint(info.id, null)
      const dropped = project(ev) ? layout.posAt(hit) : null
      if (dropped && onPieceDrag && !samePos(dropped, info.from)) {
        const oldHome = controller.homeOf(info.id)
        onPieceDrag(info.id, info.from, dropped)
        // Owner answers via the pieces prop; if home is unchanged shortly
        // after, the drop was rejected, glide back.
        window.setTimeout(() => {
          const h = controller.homeOf(info.id)
          if (h && oldHome && h.equals(oldHome)) controller.snapHome(info.id)
        }, 80)
      } else {
        controller.snapHome(info.id)
      }
    }
    el.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      el.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [dragId, gl, camera, layout, controller, onPieceDrag, upright, setHover])

  // ---- pick plane -----------------------------------------------------------
  const pickPlane = upright ? (
    <mesh
      position={[0, 0.34 + layout.frameHeight / 2, 0.14]}
      onPointerMove={(e) => {
        if (!interactive || dragInfo.current) return
        setHover(layout.posAt(e.point))
      }}
      onPointerOut={() => !dragInfo.current && setHover(null)}
      onClick={(e) => {
        if (!interactive || !onSquareClick) return
        const pos = layout.posAt(e.point)
        if (pos) onSquareClick(pos)
      }}
    >
      <planeGeometry args={[layout.width + 1, layout.frameHeight + 1]} />
      <meshBasicMaterial transparent opacity={0} colorWrite={false} depthWrite={false} />
    </mesh>
  ) : (
    <mesh
      rotation-x={-Math.PI / 2}
      position={[0, layout.boardTopY + 0.004, 0]}
      onPointerMove={(e) => {
        if (!interactive || dragInfo.current) return
        setHover(layout.posAt(e.point))
      }}
      onPointerOut={() => !dragInfo.current && setHover(null)}
      onClick={(e) => {
        if (!interactive || !onSquareClick) return
        const pos = layout.posAt(e.point)
        if (pos) onSquareClick(pos)
      }}
    >
      <planeGeometry args={[layout.width, layout.depth]} />
      <meshBasicMaterial transparent opacity={0} colorWrite={false} depthWrite={false} />
    </mesh>
  )

  // ---- piece system ----------------------------------------------------------
  const capacity = Math.max(64, layout.shape.files * layout.shape.ranks + 16)
  const systemProps = {
    pieces: prepared,
    ghosts,
    controller,
    capacity,
    seatYaw: layout.seatYaw,
    upright,
    artBase,
    removeGhost,
    onPieceOver: (id: string) => onPieceOver(id),
    onPieceOut: (id: string) => onPieceOut(id),
    onPieceDown
  }
  let system: JSX.Element
  switch (provider.system) {
    case 'goStone':
      system = <GoStones {...systemProps} params={provider.stone} />
      break
    case 'disc':
      system = <Discs {...systemProps} params={provider.disc} />
      break
    case 'wedge':
      system = <Wedges {...systemProps} params={provider.wedge} />
      break
    case 'token':
      system = <Tokens {...systemProps} params={provider.token} />
      break
    case 'chessSet':
      // Owns the board too (the Poly Haven scan includes board + frame, with
      // BoardPlane as its own internal loading/failure fallback).
      system = (
        <ChessSetSystem
          {...systemProps}
          params={provider.chessSet}
          layout={layout}
          boardStyle={provider.board}
        />
      )
      break
  }

  return (
    <group>
      <SceneEnv />
      <Lights span={span} />
      <Table span={span} artBase={artBase} />
      <ContactShadows
        position={[0, 0.002, 0]}
        scale={span * 2.4}
        far={upright ? layout.frameHeight + 1 : 3}
        blur={2.4}
        opacity={0.45}
        resolution={512}
      />
      {provider.system !== 'chessSet' ? (
        <BoardPlane layout={layout} style={provider.board} artBase={artBase} />
      ) : null}
      {system}
      {interactive && hoverPos ? <HoverMarker layout={layout} pos={hoverPos} /> : null}
      {pickPlane}
      {/* The camera stays at the user's seat (theta 0): orientation is done by
          the LAYOUT mirroring the world (and seatYaw turning the pieces).
          Feeding seatYaw to the camera too walked it to the far side and
          cancelled the mirror: the OTB auto-flip became a visual no-op.
          Replay Theater hands the camera (and the scene clock) to the
          cinematic rig instead: no OrbitControls, choreography drives. */}
      {theater ? (
        <TheaterRig directive={theater} layout={layout} span={span} upright={upright} />
      ) : (
        <CameraRig
          center={layout.center}
          span={span}
          topDown={topDown}
          upright={upright}
          enabled={!dragId}
        />
      )}
    </group>
  )
}

export function Tabletop3D({
  ref,
  kind,
  board,
  pieces,
  orientation = 'white',
  interactive = false,
  onSquareClick,
  onPieceDrag,
  onUnavailable,
  artBaseUrl,
  topDown = false,
  theater,
  onCanvasReady,
  className
}: Tabletop3DProps & { ref?: Ref<Tabletop3DHandle> }): JSX.Element | null {
  const webgl = useMemo(() => detectWebGL(), [])
  const provider = getTabletopProvider(kind)
  const [lost, setLost] = useState(false)

  const unavailable = !webgl.ok
    ? (webgl.reason ?? 'webgl-unsupported')
    : !provider
      ? 'no-3d-provider'
      : lost
        ? 'context-lost'
        : null

  const onUnavailableRef = useRef(onUnavailable)
  onUnavailableRef.current = onUnavailable
  useEffect(() => {
    if (unavailable) onUnavailableRef.current?.(unavailable)
  }, [unavailable])

  const layout = useMemo(
    () =>
      createLayout(board, orientation, {
        slabHeight: provider?.board.slabHeight
      }),
    [board, orientation, provider]
  )
  const controller = useRef<MotionController | null>(null)
  if (!controller.current) controller.current = new MotionController()
  const apiRef = useRef<SceneApi | null>(null)
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  useImperativeHandle(
    ref,
    (): Tabletop3DHandle => ({
      animateMove: (pieceId, to) =>
        controller.current?.moveTo(pieceId, layoutRef.current.worldOf(to)),
      animateCapture: (pieceId) => apiRef.current?.capture(pieceId),
      animateFlip: (pieceId) => apiRef.current?.flip(pieceId)
    }),
    []
  )

  if (unavailable || !provider) {
    // Caller supplies the 2D fallback UI (onUnavailable already fired).
    return null
  }

  return (
    <Canvas
      className={className}
      shadows
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: true }}
      camera={{ fov: 42, near: 0.1, far: 300, position: [0, 10, 12] }}
      onCreated={({ gl }) => {
        gl.domElement.addEventListener('webglcontextlost', (e) => {
          e.preventDefault()
          setLost(true)
        })
        onCanvasReady?.(gl.domElement)
      }}
    >
      <TabletopScene
        layout={layout}
        provider={provider}
        pieces={pieces}
        interactive={interactive}
        topDown={topDown}
        artBase={artBaseUrl}
        onSquareClick={onSquareClick}
        onPieceDrag={onPieceDrag}
        theater={theater}
        controller={controller.current}
        apiRef={apiRef}
      />
    </Canvas>
  )
}
