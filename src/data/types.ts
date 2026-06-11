// 卡片資料 schema — data/cards.json 的型別定義
// 主鍵：卡片編號（id）。同編號＝同一張卡；不同卡面（稀有度）放在 printings。

export type CardType = "CHARACTER" | "EVENT";

/** 五種參數。null 代表卡面的「－」：不是 0、不可比大小、不受加減、不可登場到對應區域（†1-3-2-1）。 */
export interface CharacterParams {
  serve: number | null;
  block: number | null;
  receive: number | null;
  toss: number | null;
  attack: number | null;
}

export interface Printing {
  /** 官方稀有度表記：N, R, S, 頂, P, 頂P, NP, RP, SP, D, DP, 秘, 極, 極P … 遊戲上無意義（†2-16-2） */
  rarity: string;
  /** 官網圖檔尾碼（頂→H、秘→I、極→K、其餘同稀有度） */
  imageEnd?: string;
  /** 本地卡圖路徑（public/cards/{id}-{imageEnd}.webp） */
  image: string | null;
  illustrator?: string | null;
}

export interface Card {
  /** 卡片編號，如 "HV-P01-033" */
  id: string;
  type: CardType;
  /** 卡名（日文 master 版；同名判定用這個欄位） */
  nameJa: string;
  /** 卡名繁中（可選，顯示用） */
  nameZh?: string | null;
  /** 所属（學校/隊伍），可複數 */
  affiliations: string[];
  /** ポジション（S/WS/MB/OP/Li…），可複數；EVENT 為空 */
  positions: string[];
  /** 学年（1年/2年/3年…），可複數；CSV 無此資料，待爬蟲補 */
  grades: string[];
  /** 角色卡參數；EVENT 為 null */
  params: CharacterParams | null;
  /**
   * 時機點 icon。
   * CHARACTER＝主動型技能的使用時機（†1-3-8）；EVENT＝可打出的 Phase（†2-12）。
   * 值沿用 CSV 用語：登場/發球/攔網/抽牌/接球/舉球/攻擊/手牌…（待 M3 正規化成 enum）
   */
  timing: string[];
  /** 卡名讀音（官網 name_ruby） */
  nameRuby?: string | null;
  /**
   * 技能原文（官網日文，效果 DSL 的解析基準）。
   * 含 icon 標記：[=登場][=アタックエリア][=ドロー][=ターン1][=ドシャット(5)] 等。
   */
  skillJa: string | null;
  /** 官方注釋原文 */
  annotationJa?: string | null;
  /** 技能繁中譯文 */
  skillZh: string | null;
  /** none=無技能 / human=人工翻譯 / machine=機翻待校 / missing=有日文原文但尚無譯文 */
  skillZhStatus: "none" | "human" | "machine" | "missing";
  /** 收錄彈（HV-P01…）與商品名 */
  productType?: string;
  productName?: string;
  /** 使用者備註 */
  notes: string | null;
  printings: Printing[];
  /** 效果 DSL（M3 定義並填入）；特例卡為 script 參照 */
  effect: unknown | null;
  /** vanilla=無技能 / todo=有技能未實作 / dsl=DSL 已實作 / script=特例腳本 */
  effectStatus: "vanilla" | "todo" | "dsl" | "script";
}

/** 牌組（也用於「各校收藏卡表」——total 不一定是 40） */
export interface Deck {
  name: string;
  source: string;
  cards: { id: string; count: number }[];
}
