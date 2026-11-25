<script setup lang="ts">
import type { SettingsState } from '@/stores/setting'
import { NCheckbox, NCheckboxGroup } from 'naive-ui/es/checkbox'
import { computed } from 'vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'
import HourInput from '@/components/ui/HourInput.vue'
import RanchCubPriority from './RanchCubPriority.vue'

export type AutomationSettingsFormModel = Pick<
  SettingsState,
  | 'automation'
  | 'fertilizerBuyOrganicCount'
  | 'fertilizerBuyOrganicThresholdHours'
  | 'fertilizerBuyNormalCount'
  | 'fertilizerBuyNormalThresholdHours'
  | 'fertilizerBuyCheckIntervalMinutes'
  | 'autoAcceptFriendMinLevel'
  | 'autoAcceptRequireOwnLevel'
  | 'autoAcceptHarvestStealEnabled'
  | 'autoAcceptHarvestStealHarvest'
  | 'autoAcceptHarvestStealSteal'
> & { emailClaimHour: number | string }
& Partial<Pick<SettingsState, 'fnosIllustratedAuto' | 'fnosQuietPriority' | 'fnosRanch' | 'fnosGrassLands'>> // [fnos-fork] 图鉴、自己收菜优先 / 空闲时只保留心跳、牧场增强、牧草地

withDefaults(defineProps<{
  inRanch?: boolean
  panel?: 'automation' | 'strategy'
  /** 页面级统一保存时隐藏表单自带的底部按钮。 */
  hideSave?: boolean
  ranchAnimalOptions?: Array<{ value: number, label: string, kind: string }>
  ranchAnimalOptionsLoading?: boolean
  ranchAnimalOptionsError?: string
  accountId?: string
  connected?: boolean
  saving: boolean
  fertilizerLandTypeOptions: Array<{ label: string, value: string }>
  fertilizerOptions: Array<{ label: string, value: string }>
}>(), { inRanch: false, panel: 'automation', ranchAnimalOptions: () => [], accountId: '', connected: false })

const emit = defineEmits<{
  save: []
  reloadAnimals: []
}>()

const settings = defineModel<AutomationSettingsFormModel>({ required: true })
const ripeningOnly = computed(() => ['normal_ripen', 'organic_ripen'].includes(settings.value.automation.fertilizer ?? 'none'))
const ripeningEnabled = computed(() => ripeningOnly.value || settings.value.automation.fertilizer === 'smart')
const ripeningFertilizerLabel = computed(() => settings.value.automation.fertilizer === 'normal_ripen' ? '普通化肥' : '有机化肥')
const ranchSwitches = [
  ['ranch_harvest', '自动收获'],
  ['ranch_produce', '自动生产'],
  ['ranch_buy', '自动补栏（金券）'],
  ['ranch_activate_shed', '自动解锁一级棚（免费）'],
  ['ranch_upgrade', '自动升级建筑（金券）'],
  ['ranch_sell', '自动出售产物'],
  ['ranch_market_organic_poop', '集市粑粑兑换有机化肥'],
  ['ranch_market_organic_pinecone', '集市松果兑换有机化肥'],
  ['ranch_clean', '自动清理'],
  ['ranch_grass', '自动补充牧草'],
  ['ranch_grass_buy', '牧草不足时购买（金券）'],
  ['ranch_fill_cans', '自动填充库存罐头'],
  ['ranch_feed_normal', '普通罐头', 'ranch_feed_normal_stage'],
  ['ranch_feed_organic', '有机罐头', 'ranch_feed_organic_stage'],
  ['ranch_task', '自动领取任务奖励'],
  ['ranch_illustrated', '自动领取图鉴奖励'],
  ['ranch_share', '每日分享礼包'],
  ['ranch_daily_benefit', '每日商城福利'],
] as const
// [fnos-fork] 2026-11-17 给好友加牧草的来源
const fnosFriendFeedSources = [
  { value: 'warehouse', label: '仓库牧草（默认）' },
  { value: 'gold', label: '金币（约 60/份）' },
]
const ranchFriendSwitches = [
  ['ranch_friend_steal', '自动偷取产物'],
  ['ranch_friend_produce', '自动帮忙生产'],
  ['ranch_friend_clean', '自动清理'],
  ['ranch_stroke', '自动抚摸动物'],
  ['ranch_friend_mosquito', '自动放蚊子'],
] as const
const ranchStrategies = [
  { label: '按已解锁等级', value: 'level' },
  { label: '指定动物', value: 'preferred' },
  { label: '优先背包幼崽', value: 'bag_priority' },
]
const ranchFeedStages = [
  { label: '可喂养时就用', value: 'any' },
  { label: '仅最长阶段', value: 'longest' },
  { label: '成长期 · 加速到生产期', value: 'to_production' },
  { label: '成熟期 · 距收获 10 分钟内', value: 'near_harvest' },
]
</script>

<template>
  <div class="space-y-4">
    <div class="automation-card-layout" :class="{ 'automation-card-layout--single': inRanch }">
      <div v-if="inRanch" class="automation-card-column">
        <section class="farm-card rounded-2xl p-4">
          <div class="mb-4 flex items-start gap-3">
            <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-green-50 text-green-600 dark:bg-green-900/25 dark:text-green-400">
              <span class="i-fa-solid-paw text-xl" />
            </div>
            <div>
              <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
                {{ panel === 'strategy' ? '养殖策略' : '日常牧场' }}
              </h4>
              <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                {{ panel === 'strategy' ? '按窝和棚的空位补栏' : '管理生产、收获、补栏与每日奖励' }}
              </p>
            </div>
          </div>
          <div v-if="panel === 'automation'" class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div
              v-for="[key, label, stageKey] in ranchSwitches"
              :key="key"
              class="automation-setting-item"
              :class="{ 'ranch-feed-setting': stageKey }"
            >
              <BaseSwitch v-model="settings.automation[key]" :label="stageKey ? `${label}喂养` : label" :disabled="key === 'ranch_grass_buy' && !settings.automation.ranch_grass" />
              <BaseSelect
                v-if="stageKey"
                v-model="settings.automation[stageKey]"
                :label="`${label}使用时机`"
                :aria-label="`${label}使用时机`"
                size="small"
                :options="ranchFeedStages"
                :disabled="!settings.automation[key]"
              />
            </div>
            <div class="col-span-full text-xs text-gray-500 dark:text-gray-400">
              两种兑换可独立开启；松果按 8 小时、4 小时、1 小时兑换，粑粑按 4 小时、1 小时兑换。到访或货币到账后排队，登录、重连和日常巡查时核对集市状态。
            </div>
            <div class="automation-setting-item">
              <BaseInput v-model.number="settings.automation.ranch_grass_threshold_percent" class="w-full" label="牧草余量不超过（%）时补充" type="number" min="1" max="100" step="1" :disabled="!settings.automation.ranch_grass" />
            </div>
            <div class="automation-setting-item">
              <BaseInput v-model.number="settings.automation.ranch_check_minutes" class="w-full" label="巡查间隔（分钟）" type="number" min="1" max="60" step="1" />
              <!-- [fnos-fork] 2026-11-17 农牧严格交替后此项不再决定何时进牧场 -->
              <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
                [fnos-fork] 现在农场一轮做完就进牧场、牧场一轮做完就回农场，这一项不再决定何时进牧场（保留只为兼容旧配置）。
              </p>
            </div>
          </div>
          <div v-if="panel === 'automation'" class="mt-4">
            <h4 class="mb-2 text-sm font-bold">
              好友互动
            </h4>
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div v-for="[key, label] in ranchFriendSwitches" :key="key" class="automation-setting-item">
                <BaseSwitch v-model="settings.automation[key]" :label="label" />
              </div>
            </div>
          </div>
          <div v-else class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <BaseSelect v-model="settings.automation.ranch_strategy" label="养殖策略" :options="ranchStrategies" />
            <BaseSelect v-if="settings.automation.ranch_strategy === 'bag_priority'" v-model="settings.automation.ranch_bag_fallback" label="同类幼崽用完后" :options="ranchStrategies.slice(0, 2)" />
            <template v-if="settings.automation.ranch_strategy === 'preferred' || settings.automation.ranch_strategy === 'bag_priority' && settings.automation.ranch_bag_fallback === 'preferred'">
              <p v-if="ranchAnimalOptionsLoading" class="col-span-full text-sm text-gray-500 dark:text-gray-400" role="status">
                正在读取牧场动物选项…
              </p>
              <div v-else-if="ranchAnimalOptionsError" class="col-span-full flex flex-wrap items-center gap-2">
                <p class="text-sm text-red-600 dark:text-red-400" role="alert">
                  {{ ranchAnimalOptionsError }}
                </p>
                <BaseButton variant="secondary" size="sm" @click="emit('reloadAnimals')">
                  重试
                </BaseButton>
              </div>
              <template v-else>
                <BaseSelect v-model="settings.automation.ranch_coop_animal" label="窝 · 指定动物" :options="[{ value: 0, label: '不购买' }, ...ranchAnimalOptions.filter(animal => animal.kind === '窝')]" />
                <BaseSelect v-model="settings.automation.ranch_shed_animal" label="棚 · 指定动物" :options="[{ value: 0, label: '不购买' }, ...ranchAnimalOptions.filter(animal => animal.kind === '棚')]" />
              </template>
            </template>
          </div>
          <RanchCubPriority
            v-if="panel === 'strategy' && settings.automation.ranch_strategy === 'bag_priority'"
            v-model="settings.automation"
            :account-id="accountId"
            :connected="connected"
            class="mt-4"
          />
        </section>

        <!-- [fnos-fork] 2026-11-16 牧场增强：轮换值守、小号等大号、牧场图鉴、好友牧场（2026-11-17 起随上游移到「牧场 → 策略」页，随「保存牧场策略」保存到 fnosRanch） -->
        <section v-if="panel === 'automation' && settings.fnosRanch" class="farm-card rounded-2xl p-4" data-testid="fnos-ranch">
          <div class="mb-4 flex items-start gap-3">
            <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-sky-50 text-sky-600 dark:bg-sky-900/25 dark:text-sky-400">
              <span class="i-carbon-repeat text-xl" />
            </div>
            <div>
              <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
                飞牛增强
              </h4>
              <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                小号等大号；牧场图鉴；给好友加牧草
              </p>
            </div>
          </div>
          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.fnosRanch.altHold" label="小号：货架产物先等大号偷" />
            </div>
            <div class="automation-setting-item">
              <BaseInput v-model.number="settings.fnosRanch.altHoldFallbackMinutes" class="w-full" label="农场超时为 0 时牧场最长等（分钟）" type="number" min="5" max="720" step="5" :disabled="!settings.fnosRanch.altHold" />
            </div>
            <div class="automation-setting-item">
              <!-- [fnos-fork] 2026-11-17 普通图鉴 + 巨大图鉴（重量分等级奖励），默认开，约 30 分钟检查一次，有红点时提前 -->
              <BaseSwitch v-model="settings.fnosRanch.illustratedAutoClaim" label="牧场图鉴 / 巨大图鉴奖励自动领取" title="普通图鉴等级奖励和巨大图鉴重量分奖励；约 30 分钟随牧场巡查检查一次，收到图鉴红点时提前，「空闲时只保留心跳」期间暂停" />
            </div>
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.fnosRanch.illustratedAutoComplete" label="自动完成牧场图鉴（买幼崽优先缺的）" />
            </div>
            <div class="automation-setting-item">
              <!-- [fnos-fork] 牧歌初启成长手册：已完成任务奖励 + 积分档位奖励，默认开 -->
              <BaseSwitch v-model="settings.fnosRanch.mugeAutoClaim" label="牧歌初启成长手册奖励自动领取" title="成长手册里所有已完成任务的奖励和积分档位奖励；约 30 分钟随牧场巡查检查一次，活动未开始 / 已结束 / 已领完时静默" />
            </div>
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.fnosRanch.friendFeed" label="给好友加牧草" />
            </div>
            <!-- [fnos-fork] 2026-11-17 加草来源：默认用农场仓库牧草（7001），可改金币 -->
            <div class="automation-setting-item">
              <BaseSelect v-model="settings.fnosRanch.friendFeedSource" label="加草来源" :options="fnosFriendFeedSources" :disabled="!settings.fnosRanch.friendFeed" />
            </div>
            <div class="automation-setting-item">
              <BaseInput v-model.number="settings.fnosRanch.friendFeedPerTime" class="w-full" label="每个好友每次最多加（份）" type="number" min="1" max="500" step="1" :disabled="!settings.fnosRanch.friendFeed" />
            </div>
            <div class="automation-setting-item">
              <BaseInput v-model.number="settings.fnosRanch.friendFeedGoldKeep" class="w-full" label="自己金币低于此值不加（金币来源）" type="number" min="0" max="999999999" step="1000" :disabled="!settings.fnosRanch.friendFeed || settings.fnosRanch.friendFeedSource !== 'gold'" />
            </div>
          </div>
          <p class="mt-3 text-xs text-gray-500 leading-relaxed dark:text-gray-400">
            小号等大号沿用「大小号协作」的大号和超时设置，作用于上面的「自动收获」：有货架在等大号偷时只收成熟动物，不收货架。
            给好友加牧草挂在上面「好友互动」的好友巡查里（每轮最多 3 位好友，按到期时间给农场让路），帮忙生产用「好友互动」里的「自动帮忙生产」；加牧草默认用农场仓库的牧草（每份 1 个牧草，仓库不够时只加够库存的份数并暂停、写日志，不会改用金币）；选「金币」则扣金币（约 60 金币/份），自己金币低于保留值就不加。都不超过每次上限和好友牧草机剩余容量。
            好友互动的大小号规则与农场一致：小号开了「不偷大号的菜」时不偷大号；开了「只给大号放捣乱」时只给大号放蚊子、不帮大号清理；其余情况不给自己的大号、小号放蚊子。日志标签「牧场」。
          </p>
        </section>
      </div>

      <div v-if="!inRanch" class="automation-card-column">
        <section class="farm-card rounded-2xl p-4">
          <div class="mb-4 flex items-start gap-3">
            <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-green-50 text-green-600 dark:bg-green-900/25 dark:text-green-400">
              <span class="i-carbon-sprout text-xl" />
            </div>
            <div>
              <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
                日常农场
              </h4>
              <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                管理巡田、种植、任务和产出处理
              </p>
            </div>
          </div>

          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.automation.farm" class="automation-setting-item" label="自动种植收获" />
            </div>
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.automation.farm_harvest_tiangong" label="自动收获天工作物" />
            </div>
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.automation.farm_push" class="automation-setting-item" label="推送触发巡田" />
            </div>
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.automation.skip_own_weed_bug" class="automation-setting-item" label="巡田时跳过一键务农" />
            </div>
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.automation.land_upgrade" class="automation-setting-item" label="自动升级土地" />
            </div>
            <!-- [fnos-fork] 2026-11-16 最后 X 块地只种牧草 -->
            <template v-if="settings.fnosGrassLands">
              <div class="automation-setting-item" data-testid="fnos-grass-lands">
                <BaseInput v-model.number="settings.fnosGrassLands.count" class="w-full" label="最后 X 块地只种牧草（0=关闭）" type="number" min="0" max="24" step="1" />
              </div>
              <div class="automation-setting-item">
                <BaseSwitch v-model="settings.fnosGrassLands.autoBuy" :disabled="!settings.fnosGrassLands.count" label="牧草种子不够时自动买" />
              </div>
              <p v-if="settings.fnosGrassLands.count > 0" class="text-xs text-gray-500 leading-relaxed sm:col-span-2 dark:text-gray-400">
                已解锁土地按编号排序，最后 {{ settings.fnosGrassLands.count }} 块空出来时只种牧草（收牧草 ×20，10 分钟熟），其余地照原播种规则（含图鉴优先播种）。牧草种子不够时{{ settings.fnosGrassLands.autoBuy ? '从商店补买（20 金币/个）' : '这几块地先空着' }}，日志标签「牧草地」。
              </p>
            </template>
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.automation.task" class="automation-setting-item" label="自动做任务" />
            </div>
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.automation.sell" class="automation-setting-item" label="自动卖果实" />
            </div>
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.automation.fertilizer_gift" class="automation-setting-item" label="自动填充化肥" />
            </div>
            <div class="automation-setting-item">
              <HourInput
                v-model="settings.emailClaimHour"
                class="w-full"
                label="自动邮箱领取（时）"
                help="默认 10 时，每天检查一次；0 时为午夜。加减到边界会循环。"
              />
            </div>
          </div>
        </section>

        <section class="farm-card rounded-2xl p-4">
          <div class="mb-4 flex items-start gap-3">
            <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-600 dark:bg-amber-900/25 dark:text-amber-400">
              <span class="i-carbon-chemistry text-xl" />
            </div>
            <div>
              <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
                施肥管理
              </h4>
              <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                设置施肥策略、范围和化肥补充
              </p>
            </div>
          </div>

          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.automation.fertilizer_buy_organic" class="automation-setting-item" label="自动购买有机化肥" />
            </div>
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.automation.fertilizer_buy_normal" class="automation-setting-item" label="自动购买无机化肥" />
            </div>
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.automation.fertilizer_multi_season" class="automation-setting-item" label="多季补肥" :disabled="ripeningOnly" />
            </div>
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.automation.show_manual_fertilizer" class="automation-setting-item" label="显示手动施肥按钮" />
            </div>
          </div>

          <div
            v-if="settings.automation.fertilizer_buy_organic || settings.automation.fertilizer_buy_normal"
            class="mt-3 rounded-lg bg-green-50 p-3 text-sm space-y-3 dark:bg-green-900/20"
          >
            <div v-if="settings.automation.fertilizer_buy_organic" class="space-y-2">
              <div class="text-green-700 font-medium dark:text-green-400">
                有机化肥设置
              </div>
              <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <BaseInput v-model.number="settings.fertilizerBuyOrganicCount" label="购买数量" type="number" min="1" max="10000" />
                <BaseInput v-model.number="settings.fertilizerBuyOrganicThresholdHours" label="触发阈值 (小时)" type="number" min="1" max="990" />
              </div>
            </div>
            <div v-if="settings.automation.fertilizer_buy_normal" class="space-y-2">
              <div class="text-green-700 font-medium dark:text-green-400">
                无机化肥设置
              </div>
              <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <BaseInput v-model.number="settings.fertilizerBuyNormalCount" label="购买数量" type="number" min="1" max="10000" />
                <BaseInput v-model.number="settings.fertilizerBuyNormalThresholdHours" label="触发阈值 (小时)" type="number" min="1" max="990" />
              </div>
            </div>
            <BaseInput v-model.number="settings.fertilizerBuyCheckIntervalMinutes" label="检测间隔 (分钟)" type="number" min="1" max="1440" />
            <p class="text-xs text-gray-500 dark:text-gray-400">
              系统会按检测间隔检查化肥余量，低于阈值时自动购买。两种化肥同时开启时优先购买有机化肥。
            </p>
          </div>

          <div class="mt-3 border border-amber-200 rounded-lg bg-amber-50/60 p-3 dark:border-amber-800/60 dark:bg-amber-900/10">
            <div class="mb-2 text-sm text-amber-800 font-medium dark:text-amber-300">
              施肥范围
            </div>
            <NCheckboxGroup v-model:value="settings.automation.fertilizer_land_types">
              <div class="grid grid-cols-2 gap-2 md:grid-cols-3">
                <NCheckbox
                  v-for="option in fertilizerLandTypeOptions"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}
                </NCheckbox>
              </div>
            </NCheckboxGroup>
            <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
              仅对选中土地类型的地块执行施肥策略。
            </p>
          </div>

          <div class="mt-3 space-y-3">
            <BaseSelect v-model="settings.automation.fertilizer" label="施肥策略" :options="fertilizerOptions" />
            <div
              v-if="ripeningEnabled"
              class="flex flex-wrap gap-4 rounded-lg bg-amber-50 p-3 text-sm dark:bg-amber-900/20"
            >
              <BaseInput
                v-model.number="settings.automation.fertilizer_smart_seconds"
                label="快成熟判定秒数"
                type="number"
                min="30"
                max="3600"
                class="w-40"
              />
              <span class="flex items-end pb-2 text-xs text-gray-500 dark:text-gray-400">
                距离成熟时间 ≤ 此秒数时施{{ ripeningFertilizerLabel }}（默认 300 秒）
              </span>
              <p v-if="ripeningOnly" class="w-full text-xs text-gray-500 dark:text-gray-400">
                只在巡田时催熟，不在播种后提前施肥；每季独立判断，不受「多季补肥」开关影响。
              </p>
            </div>
          </div>
        </section>
      </div>

      <div v-if="!inRanch" class="automation-card-column">
        <section class="farm-card rounded-2xl p-4">
          <div class="mb-4 flex items-start gap-3">
            <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600 dark:bg-blue-900/25 dark:text-blue-400">
              <span class="i-carbon-user-multiple text-xl" />
            </div>
            <div>
              <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
                好友互动
              </h4>
              <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                管理好友农场互动和好友申请
              </p>
            </div>
          </div>

          <div class="automation-setting-item">
            <BaseSwitch v-model="settings.automation.friend" class="automation-setting-item" label="自动好友互动" />
          </div>
          <div v-if="settings.automation.friend" class="mt-3 rounded-lg bg-blue-50 p-3 dark:bg-blue-900/20">
            <div class="mb-2 text-xs text-blue-700 font-medium dark:text-blue-300">
              互动行为
            </div>
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div class="automation-setting-item">
                <BaseSwitch v-model="settings.automation.friend_steal" class="automation-setting-item" label="自动偷菜" />
              </div>
              <div class="automation-setting-item">
                <BaseSwitch v-model="settings.automation.friend_help" class="automation-setting-item" label="自动帮忙" />
              </div>
              <div class="automation-setting-item">
                <BaseSwitch v-model="settings.automation.friend_bad" class="automation-setting-item" label="自动捣乱" />
              </div>
              <div class="automation-setting-item">
                <BaseSwitch v-model="settings.automation.friend_help_exp_limit" class="automation-setting-item" label="经验满不帮忙" />
              </div>
              <div class="automation-setting-item">
                <BaseSwitch v-model="settings.automation.friend_help_protect_dog_ignore_exp_limit" class="automation-setting-item" label="护主犬经验满仍帮忙" />
              </div>
            </div>
          </div>

          <div class="mt-3 rounded-lg bg-blue-50 p-3 space-y-3 dark:bg-blue-900/20">
            <BaseSwitch v-model="settings.automation.friend_auto_accept" class="automation-setting-item" label="自动通过好友申请" />
            <template v-if="settings.automation.friend_auto_accept">
              <div class="grid grid-cols-1 items-end gap-3 sm:grid-cols-2">
                <BaseInput v-model.number="settings.autoAcceptFriendMinLevel" label="最低等级" type="number" min="0" max="200" />
                <BaseSwitch v-model="settings.autoAcceptRequireOwnLevel" class="automation-setting-item" label="不低于自己等级" />
              </div>
              <p class="text-xs text-gray-500 dark:text-gray-400">
                最低等级设为 0 表示不限制固定等级；开启等级条件时需同时满足所有条件。
              </p>
              <div class="flex flex-wrap items-end gap-3">
                <BaseSwitch v-model="settings.autoAcceptHarvestStealEnabled" class="automation-setting-item" label="收偷比过滤" />
                <BaseInput
                  v-model.number="settings.autoAcceptHarvestStealHarvest"
                  label="收获"
                  type="number"
                  min="0"
                  max="9999"
                  class="w-28"
                  :disabled="!settings.autoAcceptHarvestStealEnabled"
                />
                <span class="pb-2 text-xs text-gray-500 dark:text-gray-400">:</span>
                <BaseInput
                  v-model.number="settings.autoAcceptHarvestStealSteal"
                  label="偷菜"
                  type="number"
                  min="1"
                  max="9999"
                  class="w-28"
                  :disabled="!settings.autoAcceptHarvestStealEnabled"
                />
              </div>
              <p class="text-xs text-gray-500 dark:text-gray-400">
                默认按 8:1 比较收获/偷菜数量，不合格的申请会直接拒绝。
              </p>
            </template>
          </div>
        </section>

        <section class="farm-card rounded-2xl p-4">
          <div class="mb-4 flex items-start gap-3">
            <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-violet-50 text-violet-600 dark:bg-violet-900/25 dark:text-violet-400">
              <span class="i-carbon-store text-xl" />
            </div>
            <div>
              <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
                神秘商人
              </h4>
              <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                自动购买商品并接收相关提醒
              </p>
            </div>
          </div>

          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.automation.mystery_shop_auto_buy" class="automation-setting-item" label="自动购买" />
            </div>
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.automation.mystery_shop_arrival_notify" class="automation-setting-item" label="到货提醒" />
            </div>
            <div class="automation-setting-item sm:col-span-2">
              <BaseSwitch
                v-model="settings.automation.mystery_shop_purchase_notify"
                class="automation-setting-item"
                label="购买提醒"
                :disabled="!settings.automation.mystery_shop_auto_buy"
              />
            </div>
          </div>

          <div v-if="settings.automation.mystery_shop_auto_buy" class="mt-3 rounded-lg bg-gray-50 p-3 space-y-3 dark:bg-gray-800/60">
            <div class="text-sm text-gray-800 font-medium dark:text-gray-200">
              允许使用的货币
            </div>
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div class="automation-setting-item">
                <BaseSwitch v-model="settings.automation.mystery_shop_allow_gold" class="automation-setting-item" label="金币" />
              </div>
              <div class="automation-setting-item">
                <BaseSwitch v-model="settings.automation.mystery_shop_allow_coupon" class="automation-setting-item" label="点券" />
              </div>
              <div class="automation-setting-item">
                <BaseSwitch v-model="settings.automation.mystery_shop_allow_gold_bean" class="automation-setting-item" label="金豆豆" />
              </div>
              <div class="automation-setting-item">
                <BaseSwitch v-model="settings.automation.mystery_shop_allow_diamond" class="automation-setting-item" label="钻石" />
              </div>
            </div>
            <p class="text-xs text-gray-500 dark:text-gray-400">
              自动购买会先按标价币种筛选，再检查余额是否足够。提醒使用「系统设置 → 通知设置」中启用的类型和渠道。
            </p>
          </div>
          <p v-else class="mt-3 text-xs text-gray-500 dark:text-gray-400">
            到货提醒可单独开启；购买提醒需先打开自动购买。
          </p>
        </section>

        <!-- [fnos-fork] 自己收菜优先 / 空闲时只保留心跳（2026-11-16 加入，随「保存自动控制」一起保存） -->
        <section v-if="settings.fnosQuietPriority" class="farm-card rounded-2xl p-4" data-testid="fnos-quiet-priority">
          <div class="mb-4 flex items-start gap-3">
            <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600 dark:bg-emerald-900/25 dark:text-emerald-400">
              <span class="i-carbon-flash text-xl" />
            </div>
            <div>
              <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
                收菜优先与空闲
              </h4>
              <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                自己的菜先收；没事做时只保留心跳
              </p>
            </div>
          </div>

          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.fnosQuietPriority.ownHarvestFirst" class="automation-setting-item" label="自己收菜优先" />
            </div>
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.fnosQuietPriority.idleKeepaliveOnly" class="automation-setting-item" label="空闲时只保留心跳" />
            </div>
          </div>
          <div v-if="settings.fnosQuietPriority.ownHarvestFirst" class="grid grid-cols-1 mt-3 gap-3 sm:grid-cols-2">
            <BaseInput v-model.number="settings.fnosQuietPriority.mergeWindowSec" label="连续成熟合并 (秒，0=不合并)" type="number" min="0" max="30" />
          </div>
          <p class="mt-2 text-xs text-gray-500 leading-relaxed dark:text-gray-400">
            自己收菜优先：按自家作物的成熟时间准点巡田；成熟前后十几秒内好友巡查先暂停让路；收完后下一块几秒内（上面的秒数）也要成熟时，先不补种，等那块成熟一起收、一起种（最多连续合并 3 次）。
            大小号协作里开启「成熟作物先留给大号偷」的小号不受影响：仍然等大号偷过（或超时）才收，不抢点、不合并。
          </p>
          <!-- [fnos-fork] 2026-11-17 按时间表偷菜 / 好友扫描间隔 / 自家提前秒数 -->
          <div class="grid grid-cols-1 mt-3 gap-2 sm:grid-cols-2" data-testid="fnos-timetable">
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.fnosQuietPriority.timetableSteal" class="automation-setting-item" label="按时间表偷菜" />
            </div>
            <!-- [fnos-fork] 2026-11-17 用户要求「扫描频率做成可填写的，默认 5 分钟」：直接填分钟数（1～60） -->
            <BaseInput v-model.number="settings.fnosQuietPriority.friendScanMinutes" label="好友列表扫描间隔 (分钟，默认 5)" type="number" min="1" max="60" step="1" placeholder="5" data-testid="fnos-friend-scan-minutes" />
            <BaseInput v-model.number="settings.fnosQuietPriority.ownLeadSec" label="自家到期前提前 (秒)" type="number" min="0" max="10" />
          </div>
          <p class="mt-2 text-xs text-gray-500 leading-relaxed dark:text-gray-400">
            按时间表偷菜：每隔上面填的分钟数（默认 5）扫一次好友列表（关掉「按时间表偷菜」时好友巡查仍按原来的间隔），记下每位好友下次成熟 / 需要帮忙 / 牧场可偷的时间（进过的好友才知道成熟时间：每次自家巡田 / 自家牧场一轮做完，立刻把还不知道时间的好友农场、牧场轮一遍，已知时间的跳过，空地 / 暂无可偷的农场 15 分钟、牧场 10 分钟后再看；翻阅每位间隔 0.5～1 秒，每 300 位休息 15～25 秒），到点直接去，不等整轮；去的时候顺手帮忙。多位同时到点排队，偷菜、帮忙、捣乱的开关和次数上限、大小号规则都照旧。
            自家作物、动物到期前上面的秒数先进去等着，到点立即收。优先级：自己收获 &gt; 偷好友 &gt; 帮忙 &gt; 任务 / 礼包 / 图鉴 / 神秘商店 / 每日福利 / 偷收比统计 / 宠物同步等杂项（30 秒内有前面的事要做或好友巡查在跑时杂项先不做）。
            农场、牧场轮流：一边一轮做完且在这边已待满 1 分钟才切到另一边；切之前这边 30 秒内有自己的收获就先等收完（最多多等 2 分钟）。自家收获、好友时间表到点随时插队。好友页 / 牧场好友列表会显示「还多久可偷」。
          </p>
          <div v-if="settings.fnosQuietPriority.idleKeepaliveOnly" class="grid grid-cols-2 mt-3 gap-3">
            <BaseInput v-model.number="settings.fnosQuietPriority.idleMinMinutes" label="每次静默最短 (分钟)" type="number" min="1" max="180" />
            <BaseInput v-model.number="settings.fnosQuietPriority.idleMaxMinutes" label="每次静默最长 (分钟)" type="number" min="1" max="180" />
          </div>
          <p class="mt-2 text-xs text-gray-500 leading-relaxed dark:text-gray-400">
            空闲时只保留心跳：上一轮巡田没有任何动作、好友巡查也没有要去的好友时，在上面的分钟数之间随机静默，期间暂停巡田、好友巡查、出售、领任务、每日任务、神秘商店、图鉴、偷收比、化肥购买检测；心跳照常、不掉线，面板手动操作不受影响。
            自家作物成熟前 10 秒一定恢复；小号有留给大号的地时最多静默 1 分钟就复查。静默到点、土地推送发现有事要做、修改本设置或掉线重连都会结束静默。
          </p>
        </section>

        <!-- [fnos-fork] 图鉴（2026-10-28 加入，2026-11-15 从「活动设置」移到这里，随「保存自动控制」一起保存） -->
        <section v-if="settings.fnosIllustratedAuto" class="farm-card rounded-2xl p-4" data-testid="fnos-illustrated-auto">
          <div class="mb-4 flex items-start gap-3">
            <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-sky-50 text-sky-600 dark:bg-sky-900/25 dark:text-sky-400">
              <span class="i-carbon-notebook text-xl" />
            </div>
            <div>
              <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
                图鉴
              </h4>
              <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                <!-- [fnos-fork] 2026-11-17 -->
                账号运行时约每 30 分钟检查一次作物图鉴和变异图鉴的可领奖励（收到图鉴红点时提前；自动完成图鉴约每 10 分钟），保存后约 12 秒先执行一次；牧场图鉴 / 巨大图鉴在牧场空间「飞牛增强」里
              </p>
            </div>
          </div>

          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.fnosIllustratedAuto.autoClaimRewards" class="automation-setting-item" label="图鉴奖励自动领取" />
            </div>
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.fnosIllustratedAuto.autoComplete" class="automation-setting-item" label="自动完成图鉴" />
            </div>
          </div>
          <p class="mt-3 text-xs text-amber-700 leading-relaxed dark:text-amber-300">
            ⚠️ 自动完成图鉴会花金币：找出作物图鉴里未收藏、背包里没有种子、地里也没种着的作物，从种子商店买 1 个种子（只买已解锁、等级够、不需要解锁卡、未售罄且金币够的），每次检查最多买 1 个、同时最多 2 个待种；下次自动播种时先把它种下（优先播种），种下或收藏后恢复原来的播种顺序。需要打开上面的「自动种植收获」。结果在日志「图鉴」里查看。
          </p>
        </section>
      </div>
    </div>

    <div v-if="!hideSave" class="flex justify-end gap-2 border-t pt-3 dark:border-gray-700">
      <BaseButton variant="primary" size="sm" :loading="saving" @click="emit('save')">
        保存自动控制
      </BaseButton>
    </div>
  </div>
</template>

<style scoped>
.automation-setting-item {
  display: flex;
  min-height: 42px;
  align-items: center;
  padding: 9px 11px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-control);
  background: color-mix(in srgb, var(--ui-surface-strong) 58%, transparent);
}

.automation-card-layout {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
  gap: 1rem;
}

.automation-card-column {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 1rem;
}

.automation-setting-item {
  display: flex;
  min-height: 42px;
  align-items: center;
  padding: 9px 11px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-control);
  background: color-mix(in srgb, var(--ui-surface-strong) 58%, transparent);
}

.ranch-feed-setting {
  flex-direction: column;
  align-items: stretch;
  gap: 0.5rem;
}

@media (max-width: 1279px) {
  .automation-card-layout {
    display: block;
  }

  .automation-card-column {
    display: contents;
  }

  .automation-card-layout section {
    margin-bottom: 1rem;
  }
}
.automation-card-layout--single {
  display: block;
}
</style>
