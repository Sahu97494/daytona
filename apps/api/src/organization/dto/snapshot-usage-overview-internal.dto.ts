/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { z } from 'zod'

export const SnapshotUsageOverviewSchema = z.object({
  totalSnapshotQuota: z.number(),
  currentSnapshotUsage: z.number(),
})

export type SnapshotUsageOverviewInternalDto = z.infer<typeof SnapshotUsageOverviewSchema>
