<script setup lang="ts">
import type { SettingsState } from '@/stores/setting'
import { NCheckbox, NCheckboxGroup } from 'naive-ui/es/checkbox'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'
import HourInput from '@/components/ui/HourInput.vue'

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
& Partial<Pick<SettingsState, 'fnosIllustratedAuto' | 'fnosRanch' | 'fnosGrassLands'>> // [fnos-fork] 图鉴、牧场增强、牧草地

withDefaults(defineProps<{
  inRanch?: boolean
  panel?: 'automation' | 'strategy'
  ranchAnimalOptions?: Array<{ value: number, label: string, kind: string }>
  saving: boolean
  fertilizerLandTypeOptions: Array<{ label: string, value: string }>
  fertilizerOptions: Array<{ label: string, value: string }>
}>(), { inRanch: false, panel: 'automation', ranchAnimalOptions: () => [] })

const emit = defineEmits<{
  save: []
}>()

const settings = defineModel<AutomationSettingsFormModel>({ required: true })
const ranchSwitches = [
  ['ranch_harvest', '自动收获'],
  ['ranch_produce', '自动生产'],
  ['ranch_buy', '自动补栏（金券）'],
  ['ranch_upgrade', '自动升级建筑（金券）'],
  ['ranch_sell', '自动出售产物'],
  ['ranch_clean', '自动清理'],
  ['ranch_grass', '自动补充牧草'],
  ['ranch_grass_buy', '牧草不足时购买（金券）'],
  ['ranch_fill_cans', '自动填充库存罐头'],
  ['ranch_feed_normal', '普通罐头喂养'],
  ['ranch_feed_organic', '有机罐头喂养'],
  ['ranch_task', '自动领取任务奖励'],
  ['ranch_share', '每日分享礼包'],
] as const
const ranchStrategies = [
  { label: '按已解锁等级', value: 'level' },
  { label: '指定动物', value: 'preferred' },
  { label: '优先背包幼崽', value: 'bag_priority' },
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
                {{ panel === 'strategy' ? '按窝、棚空位补栏，优先使用所选动物的库存幼崽' : '管理生产、收获、补栏与每日奖励' }}
              </p>
            </div>
          </div>
          <div v-if="panel === 'automation'" class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div v-for="[key, label] in ranchSwitches" :key="key" class="automation-setting-item">
              <BaseSwitch v-model="settings.automation[key]" :label="label" :disabled="key === 'ranch_grass_buy' && !settings.automation.ranch_grass" />
            </div>
            <div class="automation-setting-item">
              <BaseInput v-model.number="settings.automation.ranch_check_minutes" class="w-full" label="巡查间隔（分钟）" type="number" min="1" max="60" step="1" />
            </div>
          </div>
          <div v-else class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <BaseSelect v-model="settings.automation.ranch_strategy" label="养殖策略" :options="ranchStrategies" />
            <BaseSelect v-if="settings.automation.ranch_strategy === 'bag_priority'" v-model="settings.automation.ranch_bag_fallback" label="库存不足时" :options="ranchStrategies.slice(0, 2)" />
            <template v-if="settings.automation.ranch_strategy === 'preferred' || settings.automation.ranch_strategy === 'bag_priority' && settings.automation.ranch_bag_fallback === 'preferred'">
              <BaseSelect v-model="settings.automation.ranch_coop_animal" label="窝 · 指定动物" :options="[{ value: 0, label: '不购买' }, ...ranchAnimalOptions.filter(animal => animal.kind === '窝')]" />
              <BaseSelect v-model="settings.automation.ranch_shed_animal" label="棚 · 指定动物" :options="[{ value: 0, label: '不购买' }, ...ranchAnimalOptions.filter(animal => animal.kind === '棚')]" />
            </template>
          </div>
        </section>

        <!-- [fnos-fork] 2026-11-16 牧场增强：轮换值守、小号等大号、牧场图鉴、好友牧场（随「保存自动控制」保存到 fnosRanch） -->
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
                农场优先，牧场轮换值守；小号等大号；牧场图鉴；好友牧场
              </p>
            </div>
          </div>
          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.fnosRanch.rotation" label="轮换值守（关闭=按上面的巡查间隔）" />
            </div>
            <div class="automation-setting-item">
              <BaseInput v-model.number="settings.fnosRanch.rotationIdleMinutes" class="w-full" label="农场无事时每隔（分钟）去牧场" type="number" min="1" max="60" step="1" :disabled="!settings.fnosRanch.rotation" />
            </div>
            <div class="automation-setting-item">
              <BaseInput v-model.number="settings.fnosRanch.rotationMinGapSeconds" class="w-full" label="两次进牧场最少间隔（秒）" type="number" min="30" max="600" step="10" :disabled="!settings.fnosRanch.rotation" />
            </div>
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.fnosRanch.altHold" label="小号：货架产物先等大号偷" />
            </div>
            <div class="automation-setting-item">
              <BaseInput v-model.number="settings.fnosRanch.altHoldFallbackMinutes" class="w-full" label="农场超时为 0 时牧场最长等（分钟）" type="number" min="5" max="720" step="5" :disabled="!settings.fnosRanch.altHold" />
            </div>
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.fnosRanch.illustratedAutoClaim" label="牧场图鉴奖励自动领取" />
            </div>
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.fnosRanch.illustratedAutoComplete" label="自动完成牧场图鉴（买幼崽优先缺的）" />
            </div>
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.fnosRanch.friendSteal" label="好友牧场：自动偷成熟产物" />
            </div>
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.fnosRanch.friendClean" label="好友牧场：清理便便" />
            </div>
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.fnosRanch.friendMosquito" label="好友牧场：打蚊子" />
            </div>
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.fnosRanch.friendFeed" label="给好友加牧草（花自己的牧草）" />
            </div>
            <div class="automation-setting-item">
              <BaseInput v-model.number="settings.fnosRanch.friendFeedPerTime" class="w-full" label="每个好友每次最多加（份）" type="number" min="1" max="500" step="1" :disabled="!settings.fnosRanch.friendFeed" />
            </div>
            <div class="automation-setting-item">
              <BaseInput v-model.number="settings.fnosRanch.friendFeedKeep" class="w-full" label="自己至少保留牧草（份）" type="number" min="0" max="99999" step="10" :disabled="!settings.fnosRanch.friendFeed" />
            </div>
            <div class="automation-setting-item">
              <BaseInput v-model.number="settings.fnosRanch.friendIntervalMinutes" class="w-full" label="好友牧场巡查间隔（分钟）" type="number" min="5" max="180" step="1" :disabled="!settings.fnosRanch.friendSteal && !settings.fnosRanch.friendClean && !settings.fnosRanch.friendMosquito && !settings.fnosRanch.friendFeed" />
            </div>
            <div class="automation-setting-item">
              <BaseInput v-model.number="settings.fnosRanch.friendMaxPerPatrol" class="w-full" label="每次最多走几个好友" type="number" min="1" max="20" step="1" :disabled="!settings.fnosRanch.friendSteal && !settings.fnosRanch.friendClean && !settings.fnosRanch.friendMosquito && !settings.fnosRanch.friendFeed" />
            </div>
            <div class="automation-setting-item">
              <BaseInput v-model.number="settings.fnosRanch.friendDailyVisitLimit" class="w-full" label="每天最多访问好友牧场（次）" type="number" min="10" max="500" step="10" :disabled="!settings.fnosRanch.friendSteal && !settings.fnosRanch.friendClean && !settings.fnosRanch.friendMosquito && !settings.fnosRanch.friendFeed" />
            </div>
          </div>
          <p class="mt-3 text-xs text-gray-500 leading-relaxed dark:text-gray-400">
            轮换值守：农场这一轮有收/种/务农或好友巡查有访问，就去牧场逛一圈；农场没事时按上面的分钟数去一次；自己的菜 1 分钟内要熟时先不去。
            小号等大号沿用「大小号协作」的大号和超时设置；有货架在等时只收成熟动物，不收货架。
            好友牧场跳过黑名单、静默时段；小号开了「不偷大号的菜」时不偷大号、开了「只给大号放捣乱」时不帮大号清害；大号优先巡查自己的小号。清理一次会清掉该好友牧场全部蚊子和便便（游戏接口不分种类），有开启种类的害才清。加牧草只在自己牧草多于保留下限时加，且不超过好友牧草机剩余容量。游戏每日次数用完后当天不再请求。日志标签「牧场」。
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
              <BaseSwitch v-model="settings.automation.fertilizer_multi_season" class="automation-setting-item" label="多季补肥" />
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
              v-if="settings.automation.fertilizer === 'smart'"
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
                距离成熟时间 ≤ 此秒数时施有机肥（默认 300 秒）
              </span>
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
              自动购买会先按标价币种筛选，再检查余额是否足够；提醒使用「用户设置 → 下线提醒」的推送渠道。
            </p>
          </div>
          <p v-else class="mt-3 text-xs text-gray-500 dark:text-gray-400">
            到货提醒可单独开启；购买提醒需先打开自动购买。
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
                账号运行时约每 10 分钟检查一次作物图鉴和变异图鉴，保存后约 12 秒先执行一次
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

    <div class="flex justify-end gap-2 border-t pt-3 dark:border-gray-700">
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
