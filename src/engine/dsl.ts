// 效果 DSL —「效果即資料」（BLUEPRINT 核心原則）
// 卡片效果以 JSON 結構描述，存於 data/effects.json，由 tools/apply-effects.mjs 併入 cards.json 的 effect 欄。
// 語義依據 docs/RULES_SPEC.md 第 6 節與官方判例（見 effects.test.ts / rulings.test.ts）：
//  - [=登場] 等觸發 icon ＝ パッシブ型：強制進待機狀態，CP 中解決（Q210 觸發強制、Q332 同時觸發任選順序、Q353 在事件卡 play 之前）
//  - 「～ば使える／～の場合に使える」＝解決時的選擇性分歧 gate（†7-7-3，不是 cost）
//  - 「〔…〕：」＝スキルコスト（†1-3-5，宣言時同時執行，付不出不能宣言）
//  - 關鍵字（†9）＝ keyword action，由引擎展開

export type ParamName = "serve" | "block" | "receive" | "toss" | "attack";
/** コート五區（與參數同名） */
export type CourtArea = ParamName;
/** Phase icon（主動型使用時機 †1-3-8／事件卡 play 時機 †2-12） */
export type PhaseIcon = "serve" | "block" | "draw" | "receive" | "toss" | "attack";
/** エリアアイコン †1-3-7（卡片在該區域技能才有效） */
export type AreaIcon = CourtArea | "court" | "hand";

/** 角色篩選（名稱比對採「目前卡名」＝含 072/073 的改名 †override） */
export interface CharaFilter {
  /** 卡名（任一符合） */
  names?: string[];
  affiliation?: string;
  position?: string;
  /** 任一ポジション符合（「WSかMBの」P02-017） */
  positionsAny?: string[];
  /** 限定キャラ所在區域（不含ガッツ） */
  area?: CourtArea[];
  /** 元々のパラメータ上限（ブロックアウト：元々のブロックポイントがN以下） */
  baseParamMax?: { param: ParamName; value: number };
  /** 元々のパラメータ＝N（P02-096「元々のアタックポイントが3」） */
  baseParamEq?: { param: ParamName; value: number };
  /** 排除卡名（P01-023「『夜久 衛輔』以外の」） */
  notNames?: string[];
  /** 目前參數值下限／＝N（P01-082「レシーブポイントが5以上の」／P02-090「ブロックポイントが3の」Q457 用修正後值） */
  effParamMin?: { param: ParamName; value: number };
  effParamEq?: { param: ParamName; value: number };
  /** スキルを持たない（P02-041） */
  skillless?: true;
}

export type Condition =
  /** 對手 OP 存在且值在範圍內；source 未指定＝任意來源 */
  | { type: "opponentOp"; max?: number; min?: number; source?: ("serve" | "block" | "attack")[] }
  /** 發生源是指定區域的キャラ（D02-004「このキャラがアタックキャラの場合」） */
  | { type: "selfArea"; area: CourtArea[] }
  /** 手牌張數上限（player 預設 self） */
  | { type: "handMax"; count: number; player?: "self" | "opponent" }
  /** 手牌張數下限（「相手の手札が4枚以上の場合」P01-033） */
  | { type: "handMin"; count: number; player?: "self" | "opponent" }
  /** 發生源這回合由手牌登場（Q202：效果登場不算） */
  | { type: "deployedFromHand" }
  /** 存在符合條件的キャラ（player 預設 self；minCount＝N人以上 P02-093） */
  | { type: "chara"; player?: "self" | "opponent"; filter: CharaFilter; minCount?: number }
  /** 自分のキャラ全員符合所属（フェイント卡条件） */
  | { type: "allCharas"; affiliation: string }
  /** 別々の所属のキャラ N 人以上 †7-1-5（每人抽一個所属，最大化相異數） */
  | { type: "distinctAffiliationCharas"; min: number }
  /** イベントエリア計數（name=同名卡；playTimingAny=具任一 play icon 的卡，每張計 1 次 Q294） */
  | { type: "eventAreaCount"; player: "self" | "opponent"; name?: string; playTimingAny?: PhaseIcon[]; min?: number; max?: number }
  | { type: "phaseIs"; phase: PhaseIcon }
  /** 「そのキャラ」（lastTarget）符合篩選 */
  | { type: "targetIs"; filter: CharaFilter }
  /** 「そのキャラ」目前參數值範圍（Q190：在前段修正之後評估） */
  | { type: "targetParam"; param: ParamName; max?: number; min?: number }
  /** 發生源由指定卡的效果登場（「どん ぴしゃり」のスキルで登場していた場合；P02-016/020） */
  | { type: "deployedByCard"; name: string }
  /** 自分のドロップにカード名異なる指定所属キャラカード N 種類以上（Q359/Q360 限キャラカード；P02-017/027） */
  | { type: "dropDistinctNames"; affiliation: string; min: number }
  /** 本技能解決中已加入手牌的張數 ≥ min（「カード3枚を加えた場合」P02-089） */
  | { type: "addedThisSkill"; min: number }
  /** 指定區ガッツ數的奇偶（「アタックエリアのガッツの数が奇数」P01-043；Q250 使用時點判定） */
  | { type: "gutsParity"; area: CourtArea; parity: "odd" | "even" }
  /** cost millDeck 棄掉的最後一張符合條件（P01-051「そのカードが梟谷の場合」） */
  | { type: "milledIs"; affiliation: string }
  /** 發生源是サイドブロッカー（P02-037/038） */
  | { type: "selfIsSideBlocker" }
  /** 本技能付出的ガッツ全部具指定ポジション（P02-050「払ったガッツすべてがS」） */
  | { type: "paidGutsAll"; position: string };

export type Cost =
  /** Nガッツ払う †1-4-8：來源在ブロックエリア時付センターブロッカー下（卡片注釈），其餘付來源卡下 */
  | { type: "guts"; count: number }
  /** 自分のコートから合計Nガッツ（任意組合 Q315；P01-085） */
  | { type: "gutsAny"; count: number }
  /** 棄手牌 N 張；filter＝「青葉城西のカード」等限定 */
  | { type: "dropFromHand"; count: number; filter?: { affiliation?: string } }
  /** 手札からこのカードをドロップする（P01-013 型） */
  | { type: "dropSelf" }
  /** 手札からカードN枚をデッキの下に置く（D03-002） */
  | { type: "handToDeckBottom"; count: number }
  /** 手札からイベントカード1枚をイベントエリアに置く（技能不發動 Q337/Q344；D03-003/P02-003） */
  | { type: "placeEventFromHand" }
  /** 指定エリア（可複數）から合計Nガッツ（D03-012「レシーブエリアから」／P01-045「トスとアタックから合計4」Q251） */
  | { type: "gutsFrom"; areas: CourtArea[]; count: number }
  /** デッキの上からN枚をドロップすれば（P01-051；棄的卡供 milledIs 判定） */
  | { type: "millDeck"; count: number }
  /** 自分の指定キャラ1人をドロップすれば（P01-091「梟谷のブロックキャラ1人をドロップ」） */
  | { type: "dropChara"; area: CourtArea; filter?: CharaFilter }
  /** 「このカードを斜めにすれば使える」＝純物理動作、無遊戲狀態（Q375；P02-027） */
  | { type: "tilt" }
  /** ガッツ狀態的這張卡自身をドロップする（P01-023 被蓋觸發的 cost） */
  | { type: "dropSelfFromCourt" }
  /** このキャラを自分のデッキの下に置く（P02-037） */
  | { type: "selfToDeckBottom" };

export type Target =
  | "self" // 發生源（無對象表記 †7-1-1）
  | "target" // そのキャラ＝最近一次選擇的對象
  | "trigger" // 遲發效果的觸發卡（「登場するたび、そのキャラ」）
  | ({ choose: true; player: "self" | "opponent" } & CharaFilter); // 選擇一名キャラ（master 選）

export type DelayedTrigger =
  | { on: "deploy"; player: "self" | "opponent"; area?: CourtArea[]; filter?: CharaFilter }
  /** 相手がロストした時（P01-090；Q324：Lost 時點不屬於任何回合，「ターン中」限制已失效） */
  | { on: "opponentLost" }
  | { on: "blockSuccess" } // 自分がブロックに成功した時
  | { on: "turnEnd" } // ターン終了時（エンドフェイズ †5-12，一回合至多待機一次）
  /** 「カードを引く以外の方法でカードを手札に加えるたび」（Q321 非抽牌入手；Q317 每張觸發一次；P01-087） */
  | { on: "handAddByEffect"; player: "opponent" };

export type Duration = "thisTurn" | "nextOpponentTurn";

export interface DeployRestriction {
  area?: CourtArea;
  /** 登場人數上限（0＝完全禁止；block 以外的區一次只登 1 人，0 即禁止） */
  maxCount?: number;
  /** 禁止「元々の param が value 以上」的キャラ登場（P01-002） */
  banBaseParamMin?: { param: ParamName; value: number };
  /** 「スキルでカードを手札に加えられない」（P01-035；Q239~241：含技能/事件的抽牌與一切入手） */
  banHandAdd?: true;
  /** maxCount 只計「手札から」的登場（P02-020「手札からブロックキャラを2人まで」） */
  fromHandOnly?: true;
  /** 「相手のセンターブロッカーのブロックポイントは無いものとして扱う」（Q372~374；DP 不加算、效果不可參照；ワンタッチ仍可用；P02-027） */
  negateCenterBlock?: true;
  /** 「相手の[=ワンタッチ(N)]…を無効にする」（Q356 任意 N；P02-016） */
  banOneTouch?: true;
  /** 「[=レシーブフェイズ][=手札]で使えるスキルを無効にする」（Q357；P02-016） */
  banHandReceiveActive?: true;
  /** 禁止指定ポジション登場（P01-084/P02-097「MBの…登場させられない」，搭配 fromHandOnly） */
  banPositions?: string[];
  /** 「相手のブロックのDPがN以下の場合、相手はブロックに失敗する」（追加判定失敗條件 †5-15-3；P02-039；Q393 判定時點） */
  blockFailIfDpMax?: number;
}

export type KeywordName = "ドシャット" | "ワンタッチ" | "フェイント" | "ブロックアウト" | "ターン1" | "Aパス" | "ツーアタック";

export type Action =
  /** 抽牌；upTo＝「N枚まで引く」可選擇不抽（P01-088）。技能抽牌受「手札に加えられない」禁止（Q241） */
  | { op: "draw"; count: number; upTo?: boolean }
  /** 「手札がN枚になるようにカードを引く」（P02-058） */
  | { op: "drawToHandSize"; size: number }
  /** 從自己棄牌區把符合條件的卡加入手牌（P01-086 強制 1／P02-056「まで」可 0；Q409 含剛付掉的 cost） */
  | { op: "dropToHand"; filter: CharaFilter; cardType?: "CHARACTER" | "EVENT"; count: number; upTo?: boolean }
  /** 「相手は手札からカードN枚をドロップする」（對手自選；P01-033/087/PR-025） */
  | { op: "forceDrop"; count: number }
  /** 數值修正（修正層 add，期限＝クリンナップ／對象非キャラ化即失效 †6-10-3）。param "choose"＝使用者選一種參數 */
  | { op: "addParam"; target: Target; param: ParamName | "choose"; amount: number }
  | { op: "if"; cond: Condition[]; then: Action[] }
  /** 「～ば使える」分歧：條件成立且 cost 付得出時，master 可選擇付出並執行 then；否則跳過 */
  | { op: "gate"; cond?: Condition[]; costs?: Cost[]; then: Action[] }
  /** 公開牌組頂 1 張，名列 names 者可加入手牌（upTo 張，可 0），其餘置於牌組底（P01-006；Q280 比對目前卡名） */
  | { op: "revealTopTutor"; names: string[]; upTo: number }
  /** 看牌組頂 count 張，名列 names 者公開 upTo 張加入手牌，其餘置底（D02-012；不足時看到沒有為止 Q197；置底順序簡化為原順序） */
  | { op: "lookTopTutor"; count: number; names?: string[]; affiliation?: string; upTo: number }
  /** 「以下から1つを選んで使える」▶選項（†7-3-1；optional＝可不使用） */
  | { op: "chooseOne"; options: { label: string; actions: Action[] }[]; optional?: boolean }
  /** 把發生源移動到自分のブロックエリア當サイドブロッカー（D02-004 灰羽；コート內移動效果保留 †3-1-5-1）。
   *  不可執行條件（補足文＋登場限制 Q196：cost 已付仍不移動）：同名 blocker 已在／blockers 已 3 人／turn 累計登場上限已達 */
  | { op: "moveSelfToBlockSide" }
  /** 公開牌組頂 1 張，符合 match 則執行 then，之後置於牌組底（P01-010；Q210 強制公開） */
  | { op: "revealTopCheck"; match: { affiliation?: string }; then: Action[] }
  /** 牌組頂 N 張置入棄牌區（upTo＝可選 0~N）；棄置的最後一張成為 lastMilled 供 milledIs 判斷（P02-067） */
  | { op: "millTop"; upTo: number; then?: Action[]; milledMatch?: { affiliation?: string; cardType?: "CHARACTER" | "EVENT" } }
  /** 強制棄手牌（可能な限り †0-2-5-5；Q301） */
  | { op: "dropFromHand"; count: number }
  /** 從自己棄牌區強制登場（Q303 強制、Q304 受同名/登場限制約束）；登場卡成為 lastTarget */
  | { op: "deployFromDrop"; filter: CharaFilter; area: CourtArea; side?: true; then?: Action[] }
  /** 從指定區把「キャラ」（頂牌；Q308 ガッツ不可）加入手牌，upTo 可選 0 */
  | { op: "moveCharaToHand"; from: CourtArea; filter: CharaFilter; upTo: number }
  /** 自分のエリア1つからガッツ N 枚加入手牌（P01-076 同所属／P01-021 名異なる音駒；Q224/Q297 湊不齊整段不執行） */
  | { op: "gutsToHand"; count: number; sameAffiliation?: true; distinctNames?: true; affiliation?: string }
  /** 自分のイベントエリアから回收（不限頂牌 Q331/Q368）；then＝「加えた場合」分歧（D03-001/P02-024） */
  | { op: "eventAreaToHand"; filter?: { names?: string[]; affiliation?: string }; count: number; upTo?: boolean; then?: Action[] }
  /** 手札からカードN枚をデッキの下に置く（D03-001 的「加えた場合」） */
  | { op: "handToDeckBottom"; count: number }
  /** 自分のガッツから登場（P02-087；fromArea＝限定來源區 P02-096；then＝對登場卡（lastTarget）的後續） */
  | { op: "deployFromGuts"; filter: CharaFilter; area: CourtArea; upTo: number; fromArea?: CourtArea; then?: Action[] }
  /** 數值「固定」修正（「レシーブポイントを7にする」P01-082；後續 add 再疊加 †0-2-12 依解決順序） */
  | { op: "setParam"; target: Target; param: ParamName; value: number }
  /** デッキ頂 count 枚強制ドロップ；全部符合 match → then（P02-041；Q395 0枚不成立/Q396 可能な限り） */
  | { op: "millTopAll"; count: number; match?: { affiliation: string }; then?: Action[] }
  /** 相手の指定エリアのガッツを upTo 枚までドロップ（P02-046；Q400 由 master 選） */
  | { op: "dropOpponentGuts"; area: CourtArea; upTo: number }
  /** コインを投げる（P02-048；Q402 任意隨機方式＝引擎內嵌 RNG） */
  | { op: "coinFlip"; heads: Action[]; tails: Action[] }
  /** 自分のガッツ1枚を指定エリアのガッツにする（P02-050；Q405 任意區來源） */
  | { op: "moveGutsToArea"; filter: CharaFilter; area: CourtArea; upTo: number }
  /** 註冊遲發監看（期限內每次觸發＝待機一次 †6-6-1①） */
  | { op: "watch"; trigger: DelayedTrigger; duration: Duration; actions: Action[] }
  /** 登場限制（次の相手のターン中；效果登場也受限 Q191/Q204） */
  | { op: "restrict"; restriction: DeployRestriction; duration: "nextOpponentTurn" }
  /** 關鍵字 †9（引擎展開） */
  | { op: "keyword"; name: KeywordName; n?: number }
  /** 自分の OP を N にする（ドシャット解決） */
  | { op: "setOwnOp"; value: number }
  /** 相手のアタック OP に−N（ワンタッチ） */
  | { op: "addOpponentOp"; amount: number }
  /** 跳過進行中 phase → 移行（†8-6；block 跳過時サイドブロッカー進棄牌 †8-6-6） */
  | { op: "skipToPhase"; phase: "draw" | "end" }
  /** 算出自分のアタック OP として N（ツーアタック） */
  | { op: "calcAttackOpAs"; value: number }
  /** 相手はロストする（ブロックアウト） */
  | { op: "lostOpponent" };

export type PassiveTrigger =
  /** 這張卡登場時（含效果登場 †6-6-2-3 領域移動誘發）。overNames＝「「X」の上に登場した時」 */
  | { on: "deploy"; overNames?: string[] }
  /** 自分のキャラが登場した時（D02-004「自分のブロックキャラが登場した時」；發生源自身另在場上） */
  | { on: "allyDeploy"; area?: CourtArea[] }
  /** 這張卡被蓋（成為ガッツ）時觸發——「下にある場合」有效的技能 †1-2-15-2-1（P01-047；by＝蓋上來的卡的條件） */
  | { on: "covered"; by?: CharaFilter; area?: CourtArea[] };

export type SkillDef =
  /** パッシブ型：trigger 滿足→待機→CP 解決 */
  | { kind: "passive"; trigger: PassiveTrigger; areaIcons?: AreaIcon[]; turn1?: boolean; actions: Action[] }
  /** アクティブ型：自由 St 宣言。phaseIcons＝使用時機 †1-3-8；cost＝スキルコスト †1-3-5 */
  | { kind: "active"; phaseIcons: PhaseIcon[]; areaIcons: AreaIcon[]; turn1?: boolean; costs?: Cost[]; cond?: Condition[]; actions: Action[] }
  /** イベント型：play 時機看 card.timing；プレイ→イベントエリア→使用宣言→解決 †6-8 */
  | { kind: "event"; turn1?: boolean; actions: Action[] }
  /** 置換效果：登場する際、カード名を names のいずれかにする（072/073；登場前適用 Q284） */
  | { kind: "deployNameChoice"; names: string[] };

export interface EffectDef {
  skills: SkillDef[];
}
