/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { z } from 'zod'

export const SandboxUsageOverviewSchema = z.object({
  totalCpuQuota: z.number(),
  totalMemoryQuota: z.number(),
  totalDiskQuota: z.number(),
  currentCpuUsage: z.number(),
  currentMemoryUsage: z.number(),
  currentDiskUsage: z.number(),
})

export type SandboxUsageOverviewInternalDto = z.infer<typeof SandboxUsageOverviewSchema>
