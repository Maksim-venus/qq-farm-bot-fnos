<script setup lang="ts">
import { gatewayPath } from '@/utils/gateway'

withDefaults(defineProps<{ size?: number | string }>(), { size: 28 })

const iconSrc = gatewayPath('/icon.svg?v=farmhouse-1')
</script>

<template>
  <img class="brand-mark-svg" :src="iconSrc" :width="size" :height="size" alt="" aria-hidden="true">
</template>

<style scoped>
.brand-mark-svg {
  display: block;
  flex: none;
}
</style>
