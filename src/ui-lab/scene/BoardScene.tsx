// M9a 場景組裝：桌面（官方對戰墊風：深色底＋卡槽細線框＋槽位文字）＋依 placements 擺卡。
// CP5b（[使用者 2026-07-10] 回饋輪二）：排球網移除、槽位標籤（空槽才顯示）、
// ガッツ張數徽章、牌堆側面灰線（一張一張的質感）、疊放區點擊展開、發光收斂為邊框。

import { ContactShadows, Html, useTexture } from "@react-three/drei";
import { type ThreeEvent, useFrame } from "@react-three/fiber";
import { useMemo, useRef, Suspense } from "react";
import * as THREE from "three";
import { cardBackUrl } from "../assets";
import type { ZoneId } from "../presentation/events";
import { ZONE_LABEL } from "../presentation/textRenderer";
import styles from "../UiLabApp.module.css";
import { AnimatedCard } from "./AnimatedCard";
import { BORDER_COLOR, CORNER_R, cardBodyGeometry, cardFaceGeometry, faceGeometry, roundedShape } from "./CardMesh";
import { GlowFrame } from "./GlowFrame";
import { blockSideAnchor, CARD_T, CARD_W, CARD_H, MAT_D, MAT_W, SLOT_H, SLOT_W, zoneAnchor } from "./layout";
import type { BoardPlacements } from "./placements";


/** 有疊放（ガッツ）語意的場上區 */
const STACK_ZONES: ReadonlySet<ZoneId> = new Set(["serve", "blockCenter", "receive", "toss", "attack"]);

/** 檯面英文區名（[使用者 2026-07-12] #5：檯面標籤改英文＋Noto Sans、Html 呈現，好改樣式）。 */
const BOARD_LABEL_EN: Partial<Record<ZoneId, string>> = {
  serve: "SERVE",
  receive: "RECEIVE",
  toss: "TOSS",
  attack: "ATTACK",
  eventArea: "EVENT",
  setArea: "SET",
  deck: "DECK",
  drop: "DISCARD",
};

/** 桌墊卡槽（[使用者 2026-07-18] #5：匡線取消，改圓角灰色色塊）。
 *  圓角 radius＝卡片同款 CORNER_R；陰影＝同幾何的深色偏移層（+x/+z），
 *  呼應 DOM 元件 --shadow-hard 的硬邊位移「貼紙浮起」語言——平面幾何即可，毋須 shader。 */
const SLOT_PLATE_GEO = faceGeometry(SLOT_W, SLOT_H, CORNER_R);
/** [使用者 2026-07-18] 輪二：兩層更貼近，只留一點點位移。 */
const PLATE_SHADOW_OFFSET: [number, number, number] = [0.03, -0.0015, 0.03];
const PLATE_COLOR = "#d3d7db";
const PLATE_SHADOW_COLOR = "#1b2128";
function SlotPlate(props: { x: number; z: number; label?: string; showLabel?: boolean }): React.JSX.Element {
  return (
    <group position={[props.x, 0.006, props.z]}>
      <mesh geometry={SLOT_PLATE_GEO} position={PLATE_SHADOW_OFFSET} renderOrder={1}>
        <meshBasicMaterial color={PLATE_SHADOW_COLOR} transparent opacity={0.3} depthWrite={false} />
      </mesh>
      <mesh geometry={SLOT_PLATE_GEO} renderOrder={2}>
        <meshStandardMaterial color={PLATE_COLOR} roughness={0.95} transparent opacity={0.96} depthWrite={false} />
      </mesh>
      {props.label && props.showLabel && (
        <Html position={[0, 0.02, 0]} center style={{ pointerEvents: "none" }} zIndexRange={[1, 0]}>
          <span className={styles.zoneLabel}>{props.label}</span>
        </Html>
      )}
    </group>
  );
}

/**
 * 攔網橫條：左右 blockSide ＋ 中央 blockCenter 合為一整條橫式「隊型色塊」。
 * [使用者 2026-07-18] #5：線框改整條圓角灰色色塊（radius 同卡片）＋硬邊位移陰影；
 * 中央格以較深灰的圓角色塊疊在上面，仍代表主攔網手位置。
 */
function BlockRow(props: { player: 0 | 1; hasCards: boolean }): React.JSX.Element {
  const p = props.player;
  const cen = zoneAnchor(p, "blockCenter");
  const side0 = blockSideAnchor(p, 0); // P0 右側；P1 左側
  const side1 = blockSideAnchor(p, 1); // P0 左側；P1 右側
  // 橫條總寬 = 三格中心距 + 一格寬；P0 blockSide x 在 ±1.9，blockCenter x 在 0
  const leftX = Math.min(side0.x, side1.x, cen.x) - SLOT_W / 2;
  const rightX = Math.max(side0.x, side1.x, cen.x) + SLOT_W / 2;
  const barW = rightX - leftX;
  const barCX = (leftX + rightX) / 2;
  const barZ = cen.z;
  const barGeo = useMemo(() => faceGeometry(barW, SLOT_H, CORNER_R), [barW]);
  return (
    <group position={[0, 0.006, barZ]}>
      {/* 整條色塊的硬邊位移陰影 */}
      <mesh geometry={barGeo} position={[barCX + PLATE_SHADOW_OFFSET[0], PLATE_SHADOW_OFFSET[1], PLATE_SHADOW_OFFSET[2]]} renderOrder={1}>
        <meshBasicMaterial color={PLATE_SHADOW_COLOR} transparent opacity={0.3} depthWrite={false} />
      </mesh>
      {/* 整條圓角灰色色塊 */}
      <mesh geometry={barGeo} position={[barCX, 0, 0]} renderOrder={2}>
        <meshStandardMaterial color={PLATE_COLOR} roughness={0.95} transparent opacity={0.96} depthWrite={false} />
      </mesh>
      {/* 中央攔網手格：較深灰圓角色塊，代表主攔網手位置 */}
      <mesh geometry={SLOT_PLATE_GEO} position={[cen.x, 0.001, 0]} renderOrder={3}>
        <meshStandardMaterial color="#aab0b6" roughness={0.9} transparent opacity={0.75} depthWrite={false} />
      </mesh>
      {/* 空槽標籤（整條） */}
      {!props.hasCards && (
        <Html position={[barCX, 0.02, 0]} center style={{ pointerEvents: "none" }} zIndexRange={[1, 0]}>
          <span className={styles.zoneLabel}>BLOCK</span>
        </Html>
      )}
    </group>
  );
}

/** 單側桌墊的全部卡槽；occupied＝有卡的區（標籤只在空槽顯示，避免 DOM 蓋在卡上） */
function PlayerSlots(props: { player: 0 | 1; occupied: ReadonlySet<string> }): React.JSX.Element {
  const p = props.player;
  // blockCenter 和 blockSide 已由 BlockRow 統一渲染，不列入此 map
  const zones: ZoneId[] = ["serve", "receive", "toss", "attack", "eventArea", "deck", "drop"];
  const show = (zone: string): boolean => !props.occupied.has(`${p}:${zone}`);
  const blockHasCards = !show("blockCenter") || !show("blockSide");
  return (
    <group>
      {zones.map((z) => {
        const a = zoneAnchor(p, z);
        return <SlotPlate key={z} x={a.x} z={a.z} label={BOARD_LABEL_EN[z]} showLabel={show(z)} />;
      })}
      {/* 攔網橫條（含中央格深灰塊＋左右側翼）*/}
      <BlockRow player={p} hasCards={blockHasCards} />
      {/* Set 卡選擇時卡片可展開，但桌墊底塊始終只有一格。 */}
      <SlotPlate {...zoneAnchor(p, "setArea")} label={BOARD_LABEL_EN.setArea} showLabel={show("setArea")} />
    </group>
  );
}

/** 方格紙背景 shader（CP-V5，致敬官網格線）：世界座標對齊的細格線，
 *  每 5 格加粗（graph-paper 感），格間透明讓白紙透出；鋪在桌墊之下、只在四周白紙區可見。 */
function GridFloor(): React.JSX.Element {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: {
          uColor: { value: new THREE.Color("#1b2530") },
          uCell: { value: 1.15 },
          uAlpha: { value: 0.1 },
          uMajorEvery: { value: 5.0 },
          uMajorAlpha: { value: 0.18 },
          uFade: { value: 22.0 }, // 距原點多遠開始淡出（配 fog）
          uTime: { value: 0 }, // [使用者 2026-07-12] 極慢漂移
        },
        vertexShader: /* glsl */ `
          varying vec3 vWorld;
          void main() {
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vWorld = wp.xyz;
            gl_Position = projectionMatrix * viewMatrix * wp;
          }
        `,
        fragmentShader: /* glsl */ `
          precision highp float;
          varying vec3 vWorld;
          uniform vec3 uColor;
          uniform float uCell;
          uniform float uAlpha;
          uniform float uMajorEvery;
          uniform float uMajorAlpha;
          uniform float uFade;
          uniform float uTime;
          float gridLine(vec2 uv) {
            vec2 g = abs(fract(uv - 0.5) - 0.5) / fwidth(uv);
            return 1.0 - min(min(g.x, g.y), 1.0);
          }
          void main() {
            // 極慢漂移：整片格線隨時間微移（斜向），速度非常低。
            vec2 p = vWorld.xz + vec2(uTime * 0.06, uTime * 0.035);
            float lMinor = gridLine(p / uCell) * uAlpha;
            float lMajor = gridLine(p / (uCell * uMajorEvery)) * uMajorAlpha;
            float a = max(lMinor, lMajor);
            // 徑向淡出，避免遠處硬格線與 fog 打架
            float dist = length(vWorld.xz);
            a *= 1.0 - smoothstep(uFade, uFade + 14.0, dist);
            if (a < 0.004) discard;
            gl_FragColor = vec4(uColor, a);
          }
        `,
      }),
    [],
  );
  useFrame((_, dt) => {
    const u = material.uniforms.uTime;
    if (u) u.value += Math.min(dt, 0.05);
  });
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, FLOOR_Y + 0.001, 0]} material={material} renderOrder={-1}>
      <planeGeometry args={[80, 64]} />
    </mesh>
  );
}

/** 桌墊立體板（[使用者 2026-07-12] #3：牌桌要真的有厚度立體感，不只是黑粗匡線）。
 *  一塊有可見側面的抬高板：頂面＝淺色桌墊，側面＝深色（受光成陰影＝厚度）；
 *  四周地面（含格線）壓低，桌墊即成「抬起的島」。頂面 y 與原桌墊一致，不動卡片座標。 */
const MAT_TOP_Y = 0.004;
const FLOOR_Y = -0.46; // 壓更低＝側面更高＝厚度更明顯
/** [使用者 2026-07-18] 輪三：舞台板本體改圓角（extrude 圓角輪廓），外緣由灰匡線包覆。 */
const SLAB_W = MAT_W + 2.4;
const SLAB_D = MAT_D + 1.6;
const SLAB_R = 0.6;
function MatSlab(): React.JSX.Element {
  const h = MAT_TOP_Y - FLOOR_Y;
  const cy = (MAT_TOP_Y + FLOOR_Y) / 2;
  // 圓角 extrude：材質群組 0＝頂/底 cap、1＝側牆（同 cardBodyGeometry 的視覺契約）
  const geometry = useMemo(() => {
    const geo = new THREE.ExtrudeGeometry(roundedShape(SLAB_W, SLAB_D, SLAB_R), {
      depth: h,
      bevelEnabled: false,
      curveSegments: 24,
    });
    geo.translate(0, 0, -h / 2);
    geo.rotateX(-Math.PI / 2);
    return geo;
  }, [h]);
  const mats = useMemo(() => {
    const top = new THREE.MeshStandardMaterial({ color: "#e9ebed", roughness: 0.92 });
    const side = new THREE.MeshStandardMaterial({ color: "#15181d", roughness: 0.6 }); // 近黑側面＝立體厚度
    return [top, side];
  }, []);
  return <mesh geometry={geometry} material={mats} position={[0, cy, 0]} />;
}

/** 舞台外匡線（[使用者 2026-07-18] 輪二→輪三）：貼著舞台板圓角外緣的一圈灰線，
 *  樣式同中線（#3f4954、50% 透明）——圓角矩形環（外形＝板緣、內洞＝板緣內縮線寬）。 */
function MatOutline(): React.JSX.Element {
  const geometry = useMemo(() => {
    const t = 0.06; // 線寬（略粗於中線，包覆感）
    const outer = roundedShape(SLAB_W, SLAB_D, SLAB_R);
    outer.holes.push(roundedShape(SLAB_W - 2 * t, SLAB_D - 2 * t, Math.max(SLAB_R - t, 0.02)));
    const geo = new THREE.ShapeGeometry(outer, 24);
    geo.rotateX(-Math.PI / 2);
    return geo;
  }, []);
  return (
    <mesh geometry={geometry} position={[0, MAT_TOP_Y + 0.0018, 0]}>
      <meshBasicMaterial color="#3f4954" transparent opacity={0.5} depthWrite={false} />
    </mesh>
  );
}

/** 桌面：滿版木質表面＋精品極簡風對戰桌墊（排球網已依回饋 #8 移除）。
 *  [使用者 2026-07-11 LP0] 表面延伸出視野、配 fog 淡出——看不到桌緣，「不像一張桌子」。
 *  [使用者 2026-07-12] 隊色改走卡片 highlight 呼吸燈，桌墊滾邊取消。 */
function Table(props: { occupied: ReadonlySet<string> }): React.JSX.Element {
  return (
    <group>
      {/* 滿版表面（尺寸遠超出鏡頭視野；遠端由 fog 淡入背景色）
          [Claude 2026-07-12] CP-V2 亮色：白紙桌面＋淺灰桌墊＋墨線分界。
          舊 dark-manga-paper 貼圖是暗底、乘法無法提亮 → 先拿掉走純白紙；
          表面質地留給 CP-V5 方格紙 shader。 */}
      {/* 滿版地面（壓低到 FLOOR_Y，讓桌墊成為抬起的島；遠端由 fog 淡入背景色） */}
      <mesh position={[0, FLOOR_Y - 0.03, 0]}>
        <boxGeometry args={[90, 0.06, 70]} />
        <meshStandardMaterial color="#e7e3da" roughness={0.94} />
      </mesh>
      {/* 方格紙背景 shader（CP-V5）：鋪在壓低的地面上 */}
      <GridFloor />
      {/* 桌墊立體板（頂面淺色＋深色側面＝厚度立體感） */}
      <MatSlab />
      {/* 舞台圓角灰匡線（中線同款樣式） */}
      <MatOutline />
      {/* 中線（雙方分界） */}
      <mesh position={[0, MAT_TOP_Y + 0.003, 0]}>
        <boxGeometry args={[MAT_W + 2.1, 0.002, 0.05]} />
        <meshBasicMaterial color="#3f4954" transparent opacity={0.5} depthWrite={false} />
      </mesh>
      <PlayerSlots player={0} occupied={props.occupied} />
      <PlayerSlots player={1} occupied={props.occupied} />
    </group>
  );
}

/** 牌堆側面「一張一張」的黑邊貼圖（[使用者 2026-07-12] #3：整堆黑邊，呼應真實卡背黑框）：
 *  每卡厚度一條細分隔線，repeat＝張數。 */
function useStripedEdge(count: number): THREE.CanvasTexture {
  return useMemo(() => {
    const cv = document.createElement("canvas");
    cv.width = 8;
    cv.height = 16;
    const g = cv.getContext("2d")!;
    g.fillStyle = "#141210"; // 近黑＝卡背黑框
    g.fillRect(0, 0, 8, 16);
    g.fillStyle = "rgba(180, 180, 180, 0.35)"; // 每張之間的淡分隔線
    g.fillRect(0, 0, 8, 1);
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.repeat.set(1, count);
    return tex;
  }, [count]);
}

const PILE_FACE_GEO = cardFaceGeometry();

/** 牌組/棄牌的「厚度」底座：n 張卡的實體疊 */
function Pile(props: {
  count: number;
  topUrl: string | null;
  position: [number, number, number];
  rotY: number;
  shuffling?: boolean;
  onInspect?: () => void;
}): React.JSX.Element | null {
  // useTexture 不可條件呼叫：無頂圖（棄牌底疊）以卡背佔位，頂面材質改用素色
  const tex = useTexture(props.topUrl ?? cardBackUrl(), (t) => {
    const texture = Array.isArray(t) ? t[0]! : t;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
  });
  const stripes = useStripedEdge(Math.max(props.count, 1));
  const h = Math.max(props.count, 1) * CARD_T;
  const bodyGeometry = useMemo(() => cardBodyGeometry(h), [h]);
  const { bodyMaterials, topMaterial } = useMemo(() => {
    const edge = new THREE.MeshStandardMaterial({ map: stripes, roughness: 0.95 });
    const cap = new THREE.MeshStandardMaterial({ color: BORDER_COLOR, roughness: 0.95 });
    const top = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.62 });
    return { bodyMaterials: [cap, edge], topMaterial: top };
  }, [tex, stripes]);
  if (props.count <= 0) return null;
  const handlers = {
    onPointerDown: props.onInspect ? (e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); props.onInspect?.(); } : undefined,
    onPointerOver: props.onInspect ? (e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); document.body.style.cursor = "pointer"; } : undefined,
    onPointerOut: props.onInspect ? () => { document.body.style.cursor = ""; } : undefined,
  };
  return (
    <group
      position={[props.position[0], h / 2, props.position[2]]}
      rotation={[0, props.rotY, 0]}
    >
      <mesh geometry={bodyGeometry} material={bodyMaterials} {...handlers} />
      {props.topUrl && (
        <mesh geometry={PILE_FACE_GEO} material={topMaterial} position={[0, h / 2 + 0.0015, 0]} {...handlers} />
      )}
    </group>
  );
}

export interface BoardSceneProps {
  placements: BoardPlacements;
  /** 本批已演移動的卡的來源區（新掛載卡的出生點；抽牌從牌組頂飛出） */
  origins: ReadonlyMap<number, { player: 0 | 1; zone: ZoneId }>;
  draggableUids: ReadonlySet<number>;
  /** 點選模式（mulligan 換牌／攔網多選／取 Set 卡／自由步驟技能宣告）：可點選的卡 */
  selectableUids: ReadonlySet<number>;
  /** 已選取的卡（金框） */
  selectedUids: ReadonlySet<number>;
  emphasisUids: ReadonlySet<number>;
  /** P0 手牌 1–9/0 低對比角標。 */
  handShortcuts: ReadonlyMap<number, string>;
  /** 例如 Set→手牌：移動完成前維持卡背，避免提早洩漏。 */
  deferFaceUpUids: ReadonlySet<number>;
  shufflingPlayer: 0 | 1 | null;
  readingFrameActive: boolean;
  inspectableUids: ReadonlySet<number>;
  onInspectCard: (uid: number) => void;
  onPileInspect: (player: 0 | 1, zone: "drop" | "eventArea") => void;
  onReadingFrameClose: () => void;
  onCardSelect: (uid: number) => void;
  draggingUid: number | null;
  dragPoint: React.RefObject<THREE.Vector3>;
  /** hover 拉出的手牌 uid（僅 P0 手牌） */
  hoveredUid: number | null;
  onCardHover: (uid: number | null) => void;
  onCardPin: (uid: number) => void;
  /** 合法落區（deploy 目標）；active＝指標在區內 */
  dropZone: { x: number; z: number; active: boolean } | null;
  onCardPointerDown: (uid: number) => void;
  onDragMove: (x: number, z: number) => void;
  onDragEnd: () => void;
  /** 點擊場上疊放區＝展開/收合檢視 ガッツ（回饋 #4） */
  onStackToggle: (player: 0 | 1, zone: ZoneId) => void;
  /** 雙方學校隊色（[P0, P1]）：卡片 highlight 呼吸燈（黑↔隊色）＋落區高亮用。 */
  matColors?: readonly [string, string];
}

export function BoardScene(props: BoardSceneProps): React.JSX.Element {
  const { placements, origins, draggableUids, draggingUid, dragPoint } = props;
  const cards = useMemo(() => [...placements.cards.values()], [placements]);
  const readingGroups = useMemo(() => cards.filter((card) => card.readingGroup), [cards]);
  const readingPanels = placements.readingPanels ?? [];

  /** 佔用區（槽位標籤隱藏）＋ガッツ徽章＋event/棄牌張數徽章資料 */
  const { occupied, badges, stackKeys, pileBadges } = useMemo(() => {
    const occupied = new Set<string>();
    const stackCount = new Map<string, number>();
    // [使用者 2026-07-18] #3：event／棄牌總張數＝場上頂卡（cards）＋底疊（piles）合計
    const pileTotals = new Map<string, number>();
    for (const p of placements.cards.values()) {
      occupied.add(`${p.player}:${p.zone}`);
      if (STACK_ZONES.has(p.zone)) {
        const k = `${p.player}:${p.zone}`;
        stackCount.set(k, (stackCount.get(k) ?? 0) + 1);
      }
      if (p.zone === "drop" || p.zone === "eventArea") {
        const k = `${p.player}:${p.zone}`;
        pileTotals.set(k, (pileTotals.get(k) ?? 0) + 1);
      }
    }
    for (const pile of placements.piles) {
      if (pile.count > 0) occupied.add(pile.key.startsWith("deck") ? `${pile.key.slice(4)}:deck` : "");
      const m = pile.key.match(/^(drop|ev)([01])$/);
      if (m && pile.count > 0) {
        const k = `${m[2]}:${m[1] === "drop" ? "drop" : "eventArea"}`;
        pileTotals.set(k, (pileTotals.get(k) ?? 0) + pile.count);
      }
    }
    const stackKeys = new Set([...stackCount.entries()].filter(([, n]) => n > 1).map(([key]) => key));
    const badges = [...stackCount.entries()]
      .filter(([, n]) => n > 1)
      .map(([k, n]) => {
        const [playerS, zone] = k.split(":") as [string, ZoneId];
        const player = Number(playerS) as 0 | 1;
        const a = zoneAnchor(player, zone);
        return { key: k, player, zone, x: a.x, z: a.z, guts: n - 1 };
      });
    const pileBadges = [...pileTotals.entries()]
      .filter(([, n]) => n > 0)
      .map(([k, n]) => {
        const [playerS, zone] = k.split(":") as [string, "drop" | "eventArea"];
        const player = Number(playerS) as 0 | 1;
        const a = zoneAnchor(player, zone);
        return { key: `pile-${k}`, player, zone, x: a.x, z: a.z, count: n };
      });
    return { occupied, badges, stackKeys, pileBadges };
  }, [placements]);

  const setCursor = (c: string) => {
    document.body.style.cursor = c;
  };

  return (
    <group>
      <ambientLight intensity={0.82} />
      <directionalLight position={[4, 11, 7]} intensity={1.12} />
      <directionalLight position={[-6, 6, -4]} intensity={0.34} />
      <Table occupied={occupied} />
      {props.readingFrameActive && (
        <group>
          {/* 調暗牌桌＋點擊空白收回；放大並往觀者側延伸，罩住拉近後的閱讀列。 */}
          <mesh
            position={[0, 0.72, 0.4]}
            rotation={[-Math.PI / 2, 0, 0]}
            onPointerDown={(event) => { event.stopPropagation(); props.onReadingFrameClose(); }}
          >
            <planeGeometry args={[12.6, 9.4]} />
            <meshStandardMaterial color="#20252b" transparent opacity={0.62} roughness={0.9} depthWrite={false} />
          </mesh>
          {readingPanels.map((panel) => (
            <group key={panel.key} position={panel.position}>
              <mesh rotation={[-Math.PI / 2, 0, 0]}>
                <planeGeometry args={[panel.width, panel.depth]} />
                <meshStandardMaterial color="#f7f4ed" transparent opacity={0.94} roughness={0.98} depthWrite={false} />
              </mesh>
              {[
                { position: [0, 0.012, -panel.depth / 2] as [number, number, number], size: [panel.width, 0.018, 0.035] as [number, number, number] },
                { position: [0, 0.012, panel.depth / 2] as [number, number, number], size: [panel.width, 0.018, 0.035] as [number, number, number] },
                { position: [-panel.width / 2, 0.012, 0] as [number, number, number], size: [0.035, 0.018, panel.depth] as [number, number, number] },
                { position: [panel.width / 2, 0.012, 0] as [number, number, number], size: [0.035, 0.018, panel.depth] as [number, number, number] },
              ].map((edge, index) => (
                <mesh key={index} position={edge.position}>
                  <boxGeometry args={edge.size} />
                  <meshBasicMaterial color="#1b2128" transparent opacity={0.82} />
                </mesh>
              ))}
              <Html
                position={[-panel.width / 2 + 0.2, 0.18, -panel.depth / 2 + 0.26]}
                style={{ pointerEvents: "none" }}
                zIndexRange={[6, 0]}
              >
                <div className={styles.readingPanelHeader}>
                  <strong>{panel.label}</strong>
                  <span>{panel.detail}</span>
                </div>
              </Html>
            </group>
          ))}
          {readingGroups.map((card) => (
            <Html
              key={card.readingGroup}
              /* 標籤放在該列卡片「下方」（傾角下＝往觀者側、略低）：角色/Guts 說明在面板下面。 */
              position={[card.position[0], card.position[1] - 0.42, card.position[2] + 1.02]}
              center
              style={{ pointerEvents: "none" }}
              zIndexRange={[5, 0]}
            >
              <span className={styles.readingGroupLabel}>{card.readingGroup}</span>
            </Html>
          ))}
        </group>
      )}
      {props.dropZone && (
        <GlowFrame
          width={SLOT_W}
          height={SLOT_H}
          thickness={0.07}
          color={props.dropZone.active ? "#df600d" : (props.matColors?.[0] ?? "#0052a4")}
          visible
          opacityRange={props.dropZone.active ? [0.75, 1] : [0.35, 0.6]}
          position={[props.dropZone.x, 0.02, props.dropZone.z]}
        />
      )}
      {placements.piles.map(({ key, ...p }) => {
        const dropMatch = key.match(/^drop([01])$/);
        const eventMatch = key.match(/^ev([01])$/);
        const inspect = dropMatch
          ? () => props.onPileInspect(Number(dropMatch[1]) as 0 | 1, "drop")
          : eventMatch
            ? () => props.onPileInspect(Number(eventMatch[1]) as 0 | 1, "eventArea")
            : undefined;
        return <Pile key={key} {...p} shuffling={key === `deck${props.shufflingPlayer}`} onInspect={inspect} />;
      })}
      {/* [使用者 2026-07-18] #3：event／棄牌張數小徽章（點擊＝展開該牌堆閱讀） */}
      {!props.readingFrameActive && pileBadges.map((b) => {
        const bx = b.x + SLOT_W / 2 - 0.12;
        const bz = b.z + (b.player === 0 ? -1 : 1) * (SLOT_H / 2 - 0.12);
        const zoneLabel = b.zone === "drop" ? "棄牌" : "事件";
        return (
          <Html key={b.key} position={[bx, 0.12, bz]} center zIndexRange={[4, 0]}>
            <button
              type="button"
              className={styles.pileCountBadge}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => props.onPileInspect(b.player, b.zone)}
              aria-label={`${b.player === 0 ? "我方" : "對手"}${zoneLabel}區 ${b.count} 張，點擊查看`}
            >
              <span>{b.zone === "drop" ? "DROP" : "EV"}</span><strong>{b.count}</strong>
            </button>
          </Html>
        );
      })}
      {/* ガッツ張數徽章回 DOM overlay：不再被卡面遮住；z-index 保持低於決策／提示層。 */}
      {!props.readingFrameActive && badges.map((b) => {
        const bx = b.x + SLOT_W / 2 - 0.12;
        const bz = b.z + (b.player === 0 ? -1 : 1) * (SLOT_H / 2 - 0.12);
        return (
          <Html key={b.key} position={[bx, 0.12, bz]} center zIndexRange={[4, 0]}>
            <button
              type="button"
              className={styles.gutsBadgeHtml}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => props.onStackToggle(b.player, b.zone)}
              aria-label={`${b.player === 0 ? "我方" : "對手"}${ZONE_LABEL[b.zone]} Guts ${b.guts} 張，點擊查看`}
            >
              <span>GUTS</span><strong>{b.guts}</strong>
            </button>
          </Html>
        );
      })}
      {cards.map((p) => {
        const draggable = draggableUids.has(p.uid) && draggingUid === null;
        const selectable = props.selectableUids.has(p.uid) && draggingUid === null;
        const emphasized = props.emphasisUids.has(p.uid) && draggingUid === null;
        const hoverable = p.faceUp && !!p.frontUrl && draggingUid === null;
        const stackable = stackKeys.has(`${p.player}:${p.zone}`) && draggingUid === null;
        const inspectable = props.inspectableUids.has(p.uid) && draggingUid === null;
        const org = origins.get(p.uid);
        const orgAnchor = org ? zoneAnchor(org.player, org.zone) : null;
        const renderedPlacement = props.deferFaceUpUids.has(p.uid) ? { ...p, faceUp: false } : p;
        return (
          <Suspense fallback={null} key={p.uid}>
            <AnimatedCard
              placement={renderedPlacement}
              highlighted={draggable || selectable}
              highlightColor={props.matColors?.[p.player]}
              emphasized={emphasized}
              selected={props.selectedUids.has(p.uid)}
              hovered={props.hoveredUid === p.uid && hoverable}
              dragging={draggingUid === p.uid}
              dragPoint={dragPoint}
              spawnFrom={orgAnchor ? [orgAnchor.x, 0.5, orgAnchor.z] : undefined}
              shortcutLabel={p.player === 0 && p.zone === "hand" ? props.handShortcuts.get(p.uid) : undefined}
              showBadges={!props.readingFrameActive}
              onPointerDown={
                draggable
                  ? (e) => {
                      e.stopPropagation();
                      props.onCardPointerDown(p.uid);
                    }
                  : selectable
                    ? (e) => {
                        e.stopPropagation();
                        props.onCardSelect(p.uid);
                      }
                    : stackable
                      ? (e) => {
                          e.stopPropagation();
                          props.onStackToggle(p.player, p.zone);
                        }
                    : inspectable
                        ? (e) => {
                            e.stopPropagation();
                          props.onInspectCard(p.uid);
                        }
                        : hoverable
                          ? (e) => {
                              e.stopPropagation();
                              props.onCardPin(p.uid);
                            }
                          : undefined
              }
              onPointerOver={
                draggable || selectable || hoverable || stackable || inspectable
                  ? (e) => {
                      e.stopPropagation();
                      setCursor(draggable ? "grab" : "pointer");
                      if (hoverable) props.onCardHover(p.uid);
                    }
                  : undefined
              }
              onPointerOut={
                draggable || selectable || hoverable || stackable
                  ? () => {
                      setCursor("");
                      if (hoverable) props.onCardHover(null);
                    }
                  : undefined
              }
            />
          </Suspense>
        );
      })}
      {/* 拖曳攔截平面：貼齊桌面高度——指標落點的 x/z 才等於「畫面上看到的位置」
          （平面架高會產生視差；卡牌本身仍浮在 DRAG_Y 高度，AnimatedCard 強制 ty）。 */}
      {draggingUid !== null && (
        <mesh
          position={[0, 0.02, 0]}
          rotation={[-Math.PI / 2, 0, 0]}
          onPointerMove={(e: ThreeEvent<PointerEvent>) => props.onDragMove(e.point.x, e.point.z)}
          onPointerUp={(e: ThreeEvent<PointerEvent>) => {
            e.stopPropagation();
            props.onDragEnd();
          }}
        >
          <planeGeometry args={[120, 120]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      )}
      <ContactShadows position={[0, 0.012, 0]} opacity={0.45} scale={22} blur={2.2} far={3.2} resolution={512} />
    </group>
  );
}
