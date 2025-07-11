/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  Logger,
  OnModuleInit,
  BadRequestException,
} from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { EntityManager, In, IsNull, LessThan, MoreThan, Not, Or, Repository } from 'typeorm'
import { CreateOrganizationDto } from '../dto/create-organization.dto'
import { OrganizationUsageOverviewDto } from '../dto/organization-usage-overview.dto'
import { UpdateOrganizationQuotaDto } from '../dto/update-organization-quota.dto'
import { Organization } from '../entities/organization.entity'
import { OrganizationUser } from '../entities/organization-user.entity'
import { OrganizationMemberRole } from '../enums/organization-member-role.enum'
import { OnAsyncEvent } from '../../common/decorators/on-async-event.decorator'
import { UserEvents } from '../../user/constants/user-events.constant'
import { UserCreatedEvent } from '../../user/events/user-created.event'
import { UserDeletedEvent } from '../../user/events/user-deleted.event'
import { Sandbox } from '../../sandbox/entities/sandbox.entity'
import { Snapshot } from '../../sandbox/entities/snapshot.entity'
import { SandboxState } from '../../sandbox/enums/sandbox-state.enum'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { OrganizationEvents } from '../constants/organization-events.constant'
import { CreateOrganizationQuotaDto } from '../dto/create-organization-quota.dto'
import { DEFAULT_ORGANIZATION_QUOTA } from '../../common/constants/default-organization-quota'
import { ConfigService } from '@nestjs/config'
import { UserEmailVerifiedEvent } from '../../user/events/user-email-verified.event'
import { Volume } from '../../sandbox/entities/volume.entity'
import { Cron, CronExpression } from '@nestjs/schedule'
import { InjectRedis } from '@nestjs-modules/ioredis'
import { Redis } from 'ioredis'
import { RedisLockProvider } from '../../sandbox/common/redis-lock.provider'
import { OrganizationSuspendedSandboxStoppedEvent } from '../events/organization-suspended-sandbox-stopped.event'
import { SandboxDesiredState } from '../../sandbox/enums/sandbox-desired-state.enum'
import { SnapshotRunner } from '../../sandbox/entities/snapshot-runner.entity'
import { OrganizationSuspendedSnapshotRunnerRemovedEvent } from '../events/organization-suspended-snapshot-runner-removed'
import { SystemRole } from '../../user/enums/system-role.enum'
import { SandboxUsageOverviewInternalDto, SandboxUsageOverviewSchema } from '../dto/sandbox-usage-overview-internal.dto'
import {
  SnapshotUsageOverviewInternalDto,
  SnapshotUsageOverviewSchema,
} from '../dto/snapshot-usage-overview-internal.dto'
import { VolumeState } from '../../sandbox/enums/volume-state.enum'
import { VolumeUsageOverviewInternalDto, VolumeUsageOverviewSchema } from '../dto/volume-usage-overview-internal.dto'
import { SnapshotState } from '../../sandbox/enums/snapshot-state.enum'

@Injectable()
export class OrganizationService implements OnModuleInit {
  private readonly logger = new Logger(OrganizationService.name)

  constructor(
    @InjectRedis() private readonly redis: Redis,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(Sandbox)
    private readonly sandboxRepository: Repository<Sandbox>,
    @InjectRepository(Snapshot)
    private readonly snapshotRepository: Repository<Snapshot>,
    @InjectRepository(SnapshotRunner)
    private readonly snapshotRunnerRepository: Repository<SnapshotRunner>,
    @InjectRepository(Volume)
    private readonly volumeRepository: Repository<Volume>,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
    private readonly redisLockProvider: RedisLockProvider,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.stopSuspendedOrganizationSandboxes()
  }

  async create(
    createOrganizationDto: CreateOrganizationDto,
    createdBy: string,
    personal = false,
    creatorEmailVerified = false,
  ): Promise<Organization> {
    return this.createWithEntityManager(
      this.organizationRepository.manager,
      createOrganizationDto,
      createdBy,
      creatorEmailVerified,
      personal,
    )
  }

  async findByUser(userId: string): Promise<Organization[]> {
    return this.organizationRepository.find({
      where: {
        users: {
          userId,
        },
      },
    })
  }

  async findOne(organizationId: string): Promise<Organization | null> {
    return this.organizationRepository.findOne({
      where: { id: organizationId },
    })
  }

  async findSuspended(suspendedBefore?: Date, suspendedAfter?: Date, take?: number): Promise<Organization[]> {
    return this.organizationRepository.find({
      where: {
        suspended: true,
        suspendedUntil: Or(IsNull(), MoreThan(new Date())),
        ...(suspendedBefore ? { suspendedAt: LessThan(suspendedBefore) } : {}),
        ...(suspendedAfter ? { suspendedAt: MoreThan(suspendedAfter) } : {}),
      },
      //  limit the number of organizations to avoid memory issues
      take: take || 100,
    })
  }

  async findPersonal(userId: string): Promise<Organization> {
    return this.findPersonalWithEntityManager(this.organizationRepository.manager, userId)
  }

  async delete(organizationId: string): Promise<void> {
    const organization = await this.organizationRepository.findOne({ where: { id: organizationId } })

    if (!organization) {
      throw new NotFoundException(`Organization with ID ${organizationId} not found`)
    }

    return this.removeWithEntityManager(this.organizationRepository.manager, organization)
  }

  async getSandboxUsageOverview(
    organizationId: string,
    organization?: Organization,
  ): Promise<SandboxUsageOverviewInternalDto> {
    if (organization && organization.id !== organizationId) {
      throw new BadRequestException('Organization ID mismatch')
    }

    if (!organization) {
      organization = await this.organizationRepository.findOne({ where: { id: organizationId } })
    }

    if (!organization) {
      throw new NotFoundException(`Organization with ID ${organizationId} not found`)
    }

    let sandboxUsageOverview: SandboxUsageOverviewInternalDto | null = null

    // check cache first
    const cacheKey = `sandbox-usage-${organization.id}`
    const cachedData = await this.redis.get(cacheKey)

    if (cachedData) {
      try {
        const parsed = JSON.parse(cachedData)
        sandboxUsageOverview = SandboxUsageOverviewSchema.parse(parsed)
      } catch {
        this.logger.warn(`Failed to parse cached sandbox usage overview for organization ${organizationId}`)
        this.redis.del(cacheKey)
      }
    }

    // cache hit
    if (sandboxUsageOverview) {
      return sandboxUsageOverview
    }

    // cache miss
    const ignoredStates = [SandboxState.DESTROYED, SandboxState.ARCHIVED, SandboxState.ERROR, SandboxState.BUILD_FAILED]
    const inactiveStates = [...ignoredStates, SandboxState.STOPPED, SandboxState.ARCHIVING]

    const sandboxUsageMetrics: {
      used_disk: number
      used_cpu: number
      used_mem: number
    } = await this.sandboxRepository
      .createQueryBuilder('sandbox')
      .select([
        'SUM(CASE WHEN sandbox.state NOT IN (:...ignoredStates) THEN sandbox.disk ELSE 0 END) as used_disk',
        'SUM(CASE WHEN sandbox.state NOT IN (:...inactiveStates) THEN sandbox.cpu ELSE 0 END) as used_cpu',
        'SUM(CASE WHEN sandbox.state NOT IN (:...inactiveStates) THEN sandbox.mem ELSE 0 END) as used_mem',
      ])
      .where('sandbox.organizationId = :organizationId', { organizationId })
      .setParameter('ignoredStates', ignoredStates)
      .setParameter('inactiveStates', inactiveStates)
      .getRawOne()

    const currentDiskUsage = Number(sandboxUsageMetrics.used_disk) || 0
    const currentCpuUsage = Number(sandboxUsageMetrics.used_cpu) || 0
    const currentMemoryUsage = Number(sandboxUsageMetrics.used_mem) || 0

    sandboxUsageOverview = {
      totalCpuQuota: organization.totalCpuQuota,
      totalMemoryQuota: organization.totalMemoryQuota,
      totalDiskQuota: organization.totalDiskQuota,
      currentCpuUsage,
      currentMemoryUsage,
      currentDiskUsage,
    }

    // cache the result
    await this.redis.setex(cacheKey, 10, JSON.stringify(sandboxUsageOverview))

    return sandboxUsageOverview
  }

  async getSnapshotUsageOverview(
    organizationId: string,
    organization?: Organization,
  ): Promise<SnapshotUsageOverviewInternalDto> {
    if (organization && organization.id !== organizationId) {
      throw new BadRequestException('Organization ID mismatch')
    }

    if (!organization) {
      organization = await this.organizationRepository.findOne({ where: { id: organizationId } })
    }

    if (!organization) {
      throw new NotFoundException(`Organization with ID ${organizationId} not found`)
    }

    let snapshotUsageOverview: SnapshotUsageOverviewInternalDto | null = null

    // check cache first
    const cacheKey = `snapshot-usage-${organizationId}`
    const cachedData = await this.redis.get(cacheKey)

    if (cachedData) {
      try {
        const parsed = JSON.parse(cachedData)
        return SnapshotUsageOverviewSchema.parse(parsed)
      } catch {
        this.logger.warn(`Failed to parse cached snapshot usage overview for organization ${organizationId}`)
        this.redis.del(cacheKey)
      }
    }

    // cache hit
    if (snapshotUsageOverview) {
      return snapshotUsageOverview
    }

    // cache miss
    const currentSnapshotUsage = await this.snapshotRepository.count({
      where: {
        organizationId,
        state: Not(In([SnapshotState.ERROR, SnapshotState.BUILD_FAILED, SnapshotState.INACTIVE])),
      },
    })

    snapshotUsageOverview = {
      totalSnapshotQuota: organization.snapshotQuota,
      currentSnapshotUsage,
    }

    // cache the result
    await this.redis.setex(cacheKey, 10, JSON.stringify(snapshotUsageOverview))

    return snapshotUsageOverview
  }

  async getVolumeUsageOverview(
    organizationId: string,
    organization?: Organization,
  ): Promise<VolumeUsageOverviewInternalDto> {
    if (organization && organization.id !== organizationId) {
      throw new BadRequestException('Organization ID mismatch')
    }

    if (!organization) {
      organization = await this.organizationRepository.findOne({ where: { id: organizationId } })
    }

    if (!organization) {
      throw new NotFoundException(`Organization with ID ${organizationId} not found`)
    }

    let volumeUsageOverview: VolumeUsageOverviewInternalDto | null = null

    // check cache first
    const cacheKey = `volume-usage-${organizationId}`
    const cachedData = await this.redis.get(cacheKey)

    if (cachedData) {
      try {
        const parsed = JSON.parse(cachedData)
        return VolumeUsageOverviewSchema.parse(parsed)
      } catch {
        this.logger.warn(`Failed to parse cached volume usage overview for organization ${organizationId}`)
        this.redis.del(cacheKey)
      }
    }

    // cache hit
    if (volumeUsageOverview) {
      return volumeUsageOverview
    }

    // cache miss
    const currentVolumeUsage = await this.volumeRepository.count({
      where: {
        organizationId,
        state: Not(In([VolumeState.DELETED, VolumeState.ERROR])),
      },
    })

    volumeUsageOverview = {
      totalVolumeQuota: organization.volumeQuota,
      currentVolumeUsage,
    }

    // cache the result
    await this.redis.setex(cacheKey, 10, JSON.stringify(volumeUsageOverview))

    return volumeUsageOverview
  }

  async getUsageOverview(organizationId: string): Promise<OrganizationUsageOverviewDto> {
    const organization = await this.organizationRepository.findOne({ where: { id: organizationId } })
    if (!organization) {
      throw new NotFoundException(`Organization with ID ${organizationId} not found`)
    }

    const sandboxUsageOverview = await this.getSandboxUsageOverview(organizationId, organization)
    const snapshotUsageOverview = await this.getSnapshotUsageOverview(organizationId, organization)
    const volumeUsageOverview = await this.getVolumeUsageOverview(organizationId, organization)

    return {
      ...sandboxUsageOverview,
      ...snapshotUsageOverview,
      ...volumeUsageOverview,
    }
  }

  async updateQuota(
    organizationId: string,
    updateOrganizationQuotaDto: UpdateOrganizationQuotaDto,
  ): Promise<Organization> {
    const organization = await this.organizationRepository.findOne({ where: { id: organizationId } })
    if (!organization) {
      throw new NotFoundException(`Organization with ID ${organizationId} not found`)
    }

    organization.totalCpuQuota = updateOrganizationQuotaDto.totalCpuQuota ?? organization.totalCpuQuota
    organization.totalMemoryQuota = updateOrganizationQuotaDto.totalMemoryQuota ?? organization.totalMemoryQuota
    organization.totalDiskQuota = updateOrganizationQuotaDto.totalDiskQuota ?? organization.totalDiskQuota
    organization.maxCpuPerSandbox = updateOrganizationQuotaDto.maxCpuPerSandbox ?? organization.maxCpuPerSandbox
    organization.maxMemoryPerSandbox =
      updateOrganizationQuotaDto.maxMemoryPerSandbox ?? organization.maxMemoryPerSandbox
    organization.maxDiskPerSandbox = updateOrganizationQuotaDto.maxDiskPerSandbox ?? organization.maxDiskPerSandbox
    organization.maxSnapshotSize = updateOrganizationQuotaDto.maxSnapshotSize ?? organization.maxSnapshotSize
    organization.volumeQuota = updateOrganizationQuotaDto.volumeQuota ?? organization.volumeQuota
    organization.snapshotQuota = updateOrganizationQuotaDto.snapshotQuota ?? organization.snapshotQuota
    return this.organizationRepository.save(organization)
  }

  async suspend(organizationId: string, suspensionReason?: string, suspendedUntil?: Date): Promise<void> {
    const organization = await this.organizationRepository.findOne({ where: { id: organizationId } })
    if (!organization) {
      throw new NotFoundException(`Organization with ID ${organizationId} not found`)
    }

    organization.suspended = true
    organization.suspensionReason = suspensionReason || null
    organization.suspendedUntil = suspendedUntil || null
    organization.suspendedAt = new Date()
    await this.organizationRepository.save(organization)
  }

  async unsuspend(organizationId: string): Promise<void> {
    const organization = await this.organizationRepository.findOne({ where: { id: organizationId } })
    if (!organization) {
      throw new NotFoundException(`Organization with ID ${organizationId} not found`)
    }

    organization.suspended = false
    organization.suspensionReason = null
    organization.suspendedUntil = null
    organization.suspendedAt = null

    await this.organizationRepository.save(organization)
  }

  private async createWithEntityManager(
    entityManager: EntityManager,
    createOrganizationDto: CreateOrganizationDto,
    createdBy: string,
    creatorEmailVerified: boolean,
    personal = false,
    quota: CreateOrganizationQuotaDto = DEFAULT_ORGANIZATION_QUOTA,
  ): Promise<Organization> {
    if (personal) {
      const count = await entityManager.count(Organization, {
        where: { createdBy, personal: true },
      })
      if (count > 0) {
        throw new ForbiddenException('Personal organization already exists')
      }
    }

    // set some limit to the number of created organizations
    const createdCount = await entityManager.count(Organization, {
      where: { createdBy },
    })
    if (createdCount >= 10) {
      throw new ForbiddenException('You have reached the maximum number of created organizations')
    }

    let organization = new Organization()

    organization.name = createOrganizationDto.name
    organization.createdBy = createdBy
    organization.personal = personal

    organization.totalCpuQuota = quota.totalCpuQuota
    organization.totalMemoryQuota = quota.totalMemoryQuota
    organization.totalDiskQuota = quota.totalDiskQuota
    organization.maxCpuPerSandbox = quota.maxCpuPerSandbox
    organization.maxMemoryPerSandbox = quota.maxMemoryPerSandbox
    organization.maxDiskPerSandbox = quota.maxDiskPerSandbox
    organization.snapshotQuota = quota.snapshotQuota
    organization.maxSnapshotSize = quota.maxSnapshotSize
    organization.volumeQuota = quota.volumeQuota

    if (!creatorEmailVerified) {
      organization.suspended = true
      organization.suspendedAt = new Date()
      organization.suspensionReason = 'Please verify your email address'
    } else if (this.configService.get<boolean>('BILLING_ENABLED') && !personal) {
      organization.suspended = true
      organization.suspendedAt = new Date()
      organization.suspensionReason = 'Payment method required'
    }

    const owner = new OrganizationUser()
    owner.userId = createdBy
    owner.role = OrganizationMemberRole.OWNER

    organization.users = [owner]

    await entityManager.transaction(async (em) => {
      organization = await em.save(organization)
      await this.eventEmitter.emitAsync(OrganizationEvents.CREATED, organization)
    })

    return organization
  }

  private async removeWithEntityManager(
    entityManager: EntityManager,
    organization: Organization,
    force = false,
  ): Promise<void> {
    if (!force) {
      if (organization.personal) {
        throw new ForbiddenException('Cannot delete personal organization')
      }
    }
    await entityManager.remove(organization)
  }

  private async unsuspendPersonalWithEntityManager(entityManager: EntityManager, userId: string): Promise<void> {
    const organization = await this.findPersonalWithEntityManager(entityManager, userId)

    organization.suspended = false
    organization.suspendedAt = null
    organization.suspensionReason = null
    organization.suspendedUntil = null
    await entityManager.save(organization)
  }

  private async findPersonalWithEntityManager(entityManager: EntityManager, userId: string): Promise<Organization> {
    const organization = await entityManager.findOne(Organization, {
      where: { createdBy: userId, personal: true },
    })

    if (!organization) {
      throw new NotFoundException(`Personal organization for user ${userId} not found`)
    }

    return organization
  }

  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'stop-suspended-organization-sandboxes' })
  async stopSuspendedOrganizationSandboxes(): Promise<void> {
    //  lock the sync to only run one instance at a time
    const lockKey = 'stop-suspended-organization-sandboxes'
    if (!(await this.redisLockProvider.lock(lockKey, 60))) {
      return
    }

    const suspendedOrganizations = await this.findSuspended(
      // Find organization suspended more than 24 hours ago
      new Date(Date.now() - 1 * 1000 * 60 * 60 * 24),
      //  and less than 7 days ago
      new Date(Date.now() - 7 * 1000 * 60 * 60 * 24),
    )

    const suspendedOrganizationIds = suspendedOrganizations.map((organization) => organization.id)

    // Skip if no suspended organizations found to avoid empty IN clause
    if (suspendedOrganizationIds.length === 0) {
      await this.redis.del(lockKey)
      return
    }

    const sandboxes = await this.sandboxRepository.find({
      where: {
        organizationId: In(suspendedOrganizationIds),
        desiredState: SandboxDesiredState.STARTED,
        state: Not(In([SandboxState.ERROR, SandboxState.BUILD_FAILED])),
      },
    })

    sandboxes.map((sandbox) =>
      this.eventEmitter.emitAsync(
        OrganizationEvents.SUSPENDED_SANDBOX_STOPPED,
        new OrganizationSuspendedSandboxStoppedEvent(sandbox.id),
      ),
    )

    await this.redis.del(lockKey)
  }

  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'remove-suspended-organization-snapshot-runners' })
  async removeSuspendedOrganizationSnapshotRunners(): Promise<void> {
    //  lock the sync to only run one instance at a time
    const lockKey = 'remove-suspended-organization-snapshot-runners'
    if (!(await this.redisLockProvider.lock(lockKey, 60))) {
      return
    }

    const suspendedOrganizations = await this.findSuspended(
      new Date(Date.now() - 1 * 1000 * 60 * 60 * 24),
      new Date(Date.now() - 7 * 1000 * 60 * 60 * 24),
    )

    const suspendedOrganizationIds = suspendedOrganizations.map((organization) => organization.id)

    // Skip if no suspended organizations found to avoid empty IN clause
    if (suspendedOrganizationIds.length === 0) {
      await this.redis.del(lockKey)
      return
    }

    const snapshotRunners = await this.snapshotRunnerRepository
      .createQueryBuilder('snapshotRunner')
      .innerJoin('snapshot', 'snapshot', 'snapshot.internalName = snapshotRunner.snapshotRef')
      .where('snapshot.general = false')
      .andWhere('snapshot.organizationId IN (:...suspendedOrgIds)', { suspendedOrgIds: suspendedOrganizationIds })
      .orderBy('snapshotRunner.createdAt', 'ASC')
      .getMany()

    snapshotRunners.map((snapshotRunner) =>
      this.eventEmitter.emitAsync(
        OrganizationEvents.SUSPENDED_SNAPSHOT_RUNNER_REMOVED,
        new OrganizationSuspendedSnapshotRunnerRemovedEvent(snapshotRunner.id),
      ),
    )

    await this.redis.del(lockKey)
  }

  @OnAsyncEvent({
    event: UserEvents.CREATED,
  })
  async handleUserCreatedEvent(payload: UserCreatedEvent): Promise<Organization> {
    return this.createWithEntityManager(
      payload.entityManager,
      {
        name: 'Personal',
      },
      payload.user.id,
      payload.user.role === SystemRole.ADMIN ? true : payload.user.emailVerified,
      true,
      payload.personalOrganizationQuota,
    )
  }

  @OnAsyncEvent({
    event: UserEvents.EMAIL_VERIFIED,
  })
  async handleUserEmailVerifiedEvent(payload: UserEmailVerifiedEvent): Promise<void> {
    await this.unsuspendPersonalWithEntityManager(payload.entityManager, payload.userId)
  }

  @OnAsyncEvent({
    event: UserEvents.DELETED,
  })
  async handleUserDeletedEvent(payload: UserDeletedEvent): Promise<void> {
    const organization = await this.findPersonalWithEntityManager(payload.entityManager, payload.userId)

    await this.removeWithEntityManager(payload.entityManager, organization, true)
  }

  assertOrganizationIsNotSuspended(organization: Organization): void {
    if (!organization.suspended) {
      return
    }

    if (organization.suspendedUntil ? organization.suspendedUntil > new Date() : true) {
      if (organization.suspensionReason) {
        throw new ForbiddenException(`Organization is suspended: ${organization.suspensionReason}`)
      } else {
        throw new ForbiddenException('Organization is suspended')
      }
    }
  }
}
