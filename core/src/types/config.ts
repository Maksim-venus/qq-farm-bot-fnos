import type { NotificationTypes } from '../config/notification-types';
import type { RanchAutomationConfig } from '../config/ranch-automation';
export {};
export type PlantingStrategy =
  | 'preferred'
  | 'level'
  | 'max_exp'
  | 'max_fert_exp'
  | 'max_profit'
  | 'max_fert_profit'
  | 'bag_priority';

export type BagSeedFallbackStrategy = Exclude<PlantingStrategy, 'bag_priority'>;

export type FertilizerMode = 'both' | 'normal' | 'organic' | 'smart' | 'none' | 'normal_ripen' | 'organic_ripen';

export type FertilizerLandType = 'blue-crystal' | 'purple-gold' | 'gold' | 'black' | 'red' | 'normal';

export interface AutomationConfig extends RanchAutomationConfig {
  farm: boolean;
  farm_harvest_tiangong: boolean;
  farm_push: boolean;
  land_upgrade: boolean;
  friend: boolean;
  friend_auto_accept: boolean;
  friend_help_exp_limit: boolean;
  friend_steal: boolean;
  friend_help: boolean;
  friend_bad: boolean;
  friend_help_protect_dog_ignore_exp_limit: boolean;
  task: boolean;
  fertilizer_gift: boolean;
  fertilizer_buy_organic: boolean;
  fertilizer_buy_normal: boolean;
  mystery_shop_auto_buy: boolean;
  mystery_shop_allow_gold: boolean;
  mystery_shop_allow_coupon: boolean;
  mystery_shop_allow_gold_bean: boolean;
  mystery_shop_allow_diamond: boolean;
  mystery_shop_arrival_notify: boolean;
  mystery_shop_purchase_notify: boolean;
  sell: boolean;
  fertilizer: FertilizerMode;
  fertilizer_multi_season: boolean;
  fertilizer_land_types: FertilizerLandType[];
  fertilizer_smart_seconds: number;
  skip_own_weed_bug: boolean;
  show_manual_fertilizer: boolean;
}

export interface IntervalConfig {
  farm: number;
  farmMin: number;
  farmMax: number;
  friendMin: number;
  friendMax: number;
  helpMin: number;
  helpMax: number;
  stealMin: number;
  stealMax: number;
  [key: string]: number;
}

export interface QuietHoursConfig {
  enabled: boolean;
  start: string;
  end: string;
  continueFarm: boolean;
}

export interface AccountConfig {
  automation: AutomationConfig;
  plantingStrategy: PlantingStrategy;
  preferredSeedId: number;
  intervals: IntervalConfig;
  friendQuietHours: QuietHoursConfig;
  knownFriendGids: number[];
  knownFriendGidSyncCooldownSec: number;
  friendsListCacheTtlSec: number;
  friendBlacklist: number[];
  ranchFriendBlacklist: number[];
  plantBlacklist: number[];
  stealDelaySeconds: number;
  plantOrderRandom: boolean;
  plantDelaySeconds: number;
  fertilizerBuyOrganicCount: number;
  fertilizerBuyOrganicThresholdHours: number;
  fertilizerBuyNormalCount: number;
  fertilizerBuyNormalThresholdHours: number;
  fertilizerBuyCheckIntervalMinutes: number;
  /** 每天检查邮箱奖励的时间（0-23 点，默认 10 点）；到点后每天只触发一次。 */
  emailClaimHour: number;
  bagSeedPriority: number[];
  /** 是否为明确排在前面的多格背包种子保留尚未连成布局的空地。 */
  bagSeedMultiLandReservationEnabled: boolean;
  /** seedId -> 允许种植的土地类型。缺 key 视为不限制。 */
  bagSeedLandTypes: Record<string, FertilizerLandType[]>;
  bagSeedFallbackStrategy: BagSeedFallbackStrategy;
  autoAcceptFriendMinLevel: number;
  autoAcceptRequireOwnLevel: boolean;
  autoAcceptHarvestStealEnabled: boolean;
  autoAcceptHarvestStealHarvest: number;
  autoAcceptHarvestStealSteal: number;
  /** [fnos-fork] 大号/小号：本账号是否为小号及其大号（见 services/farm/fnos-alt-account.ts） */
  fnosAltAccount?: {
    enabled: boolean;
    masterGid: number;
    masterName: string;
    /** [fnos-fork] 成熟作物先留给大号偷（缺省视为 true）；关闭时小号正常收获，timeoutMinutes 不生效 */
    holdForMaster?: boolean;
    timeoutMinutes: number;
    /** [fnos-fork] 2026.10.21.3 大小号协作：不偷大号的菜 */
    skipStealMaster?: boolean;
    /** [fnos-fork] 2026.10.21.3 大小号协作：放草/放虫只对大号做 */
    badOnlyMaster?: boolean;
  };
  /** [fnos-fork] 2026-10-28 图鉴奖励自动领取、自动完成图鉴（见 services/fnos-illustrated-auto.ts） */
  fnosIllustratedAuto?: {
    autoClaimRewards: boolean;
    autoComplete: boolean;
  };
  /**
   * [fnos-fork] 在线期间来偷菜的自动删除（键名沿用旧的 fnosStealRatio）。
   * 2026-11-23 起偷收比阈值 / 忽略申请 / Bark / 筛选 / 自动删除已下架，旧字段读取时丢弃。
   * 见 services/friend/fnos-steal-ratio.ts。
   */
  fnosStealRatio?: {
    /** 缺省 false */
    autoDeleteOnlineStealer?: boolean;
  };
  /** [fnos-fork] 2026-11-16 自己收菜优先 / 空闲时只保留心跳（见 services/fnos-quiet-priority.ts） */
  fnosQuietPriority?: {
    ownHarvestFirst: boolean;
    mergeWindowSec: number;
    idleKeepaliveOnly: boolean;
    idleMinMinutes: number;
    idleMaxMinutes: number;
    /** [fnos-fork] 2026-11-17 按时间表偷菜 / 好友扫描间隔（分钟）/ 自家提前秒数 */
    timetableSteal?: boolean;
    friendScanMinutes?: number;
    ownLeadSec?: number;
  };
  /** [fnos-fork] 2026-11-16 牧场增强：小号等大号、图鉴、好友牧场帮生产/加牧草（见 services/ranch/fnos-ranch.ts） */
  fnosRanch?: import('../services/ranch/fnos-ranch').FnosRanchConfig;
  /** [fnos-fork] 2026-11-16 农场最后 X 块地只种牧草（见 services/farm/fnos-grass-lands.ts） */
  fnosGrassLands?: import('../services/farm/fnos-grass-lands').FnosGrassLandsConfig;
}

export interface OfflineReminderChannel {
  channel: string;
  enabled: boolean;
  endpoint: string;
  token: string;
  secret: string;
}

export interface OfflineReminder {
  notificationTypes: NotificationTypes;
  channels: OfflineReminderChannel[];
  channel: string;
  endpoint: string;
  token: string;
  secret: string;
  title: string;
  msg: string;
  offlineDeleteSec: number;
  /** [fnos-fork] Bark 渠道下线提醒使用重要警告（level=critical，静音/勿扰也响铃）；缺省视为开启 */
  barkCritical: boolean;
}

export interface UIConfig {
  theme: 'light' | 'dark';
}

export interface LoginSettings {
  wechatQrLogin: boolean;
  qqQrLogin: boolean;
  napCatEndpoint: string;
  napCatSignature: string;
}

export interface DeviceInfo {
  os: string;
  clientVersion: string;
  sysSoftware: string;
  network: string;
  memory: string;
  deviceId: string;
  userAgent: string;
}

export interface SystemConfig {
  serverUrl: string;
  clientVersion: string;
  clientVersionUpdatedAt?: number;
  wxClientVersion: string;
  wxClientVersionUpdatedAt?: number;
  platform: string;
  os: string;
  timeZone: string;
  deviceInfo: DeviceInfo;
}

export interface GlobalConfig {
  accountConfigs: Record<string, AccountConfig>;
  defaultAccountConfig: AccountConfig;
  ui: UIConfig;
  loginSettings: LoginSettings;
  offlineReminder: OfflineReminder;
  systemConfig: SystemConfig | null;
}
