import { GlobalConfig } from '@n8n/config';
import { BinaryDataService, InstanceSettings } from 'n8n-core';
import { jsonStringify } from 'n8n-workflow';
import { Service } from 'typedi';

import { TIME } from '@/constants';
import { ExecutionRepository } from '@/databases/repositories/execution.repository';
import { OnShutdown } from '@/decorators/on-shutdown';
import { Logger } from '@/logging/logger.service';

import { OrchestrationService } from '../orchestration.service';

@Service()
export class PruningService {
	private hardDeletionBatchSize = 100;

	private rates: Record<string, number> = {
		softDeletion: this.globalConfig.pruning.softDeleteInterval * TIME.MINUTE,
		hardDeletion: this.globalConfig.pruning.hardDeleteInterval * TIME.MINUTE,
	};

	public softDeletionInterval: NodeJS.Timer | undefined;

	public hardDeletionTimeout: NodeJS.Timeout | undefined;

	private isShuttingDown = false;

	constructor(
		private readonly logger: Logger,
		private readonly instanceSettings: InstanceSettings,
		private readonly executionRepository: ExecutionRepository,
		private readonly binaryDataService: BinaryDataService,
		private readonly orchestrationService: OrchestrationService,
		private readonly globalConfig: GlobalConfig,
	) {
		this.logger = this.logger.scoped('pruning');
	}

	/**
	 * @important Requires `OrchestrationService` to be initialized.
	 */
	init() {
		const { isLeader } = this.instanceSettings;
		const { isMultiMainSetupEnabled } = this.orchestrationService;

		if (isLeader) this.startPruning();

		if (isMultiMainSetupEnabled) {
			this.orchestrationService.multiMainSetup.on('leader-takeover', () => this.startPruning());
			this.orchestrationService.multiMainSetup.on('leader-stepdown', () => this.stopPruning());
		}
	}

	private isEnabled() {
		const { instanceType, isFollower } = this.instanceSettings;
		if (!this.globalConfig.pruning.isEnabled || instanceType !== 'main') {
			return false;
		}

		if (this.globalConfig.multiMainSetup.enabled && instanceType === 'main' && isFollower) {
			return false;
		}

		return true;
	}

	/**
	 * @important Call this method only after DB migrations have completed.
	 */
	startPruning() {
		if (!this.isEnabled()) return;

		if (this.isShuttingDown) {
			this.logger.warn('Cannot start pruning while shutting down');
			return;
		}

		this.logger.debug('Starting soft-deletion and hard-deletion timers');

		this.setSoftDeletionInterval();
		this.scheduleHardDeletion();
	}

	stopPruning() {
		if (!this.isEnabled()) return;

		this.logger.debug('Removing soft-deletion and hard-deletion timers');

		clearInterval(this.softDeletionInterval);
		clearTimeout(this.hardDeletionTimeout);
	}

	private setSoftDeletionInterval(rateMs = this.rates.softDeletion) {
		const when = [rateMs / TIME.MINUTE, 'min'].join(' ');

		this.softDeletionInterval = setInterval(
			async () => await this.softDeleteOnPruningCycle(),
			this.rates.softDeletion,
		);

		this.logger.debug(`Soft-deletion scheduled every ${when}`);
	}

	private scheduleHardDeletion(rateMs = this.rates.hardDeletion) {
		const when = [rateMs / TIME.MINUTE, 'min'].join(' ');

		this.hardDeletionTimeout = setTimeout(() => {
			this.hardDeleteOnPruningCycle()
				.then((rate) => this.scheduleHardDeletion(rate))
				.catch((error) => {
					this.scheduleHardDeletion(1 * TIME.SECOND);

					const errorMessage =
						error instanceof Error
							? error.message
							: jsonStringify(error, { replaceCircularRefs: true });

					this.logger.error('Failed to hard-delete executions', { errorMessage });
				});
		}, rateMs);

		this.logger.debug(`Hard-deletion scheduled for next ${when}`);
	}

	/**
	 * Mark executions as deleted based on age and count, in a pruning cycle.
	 */
	async softDeleteOnPruningCycle() {
		this.logger.debug('Starting soft-deletion of executions');

		const result = await this.executionRepository.softDeletePrunableExecutions();

		if (result.affected === 0) {
			this.logger.debug('Found no executions to soft-delete');
			return;
		}

		this.logger.debug('Soft-deleted executions', { count: result.affected });
	}

	@OnShutdown()
	shutdown(): void {
		this.isShuttingDown = true;
		this.stopPruning();
	}

	/**
	 * Permanently remove all soft-deleted executions and their binary data, in a pruning cycle.
	 * @return Delay in ms after which the next cycle should be started
	 */
	private async hardDeleteOnPruningCycle() {
		const ids = await this.executionRepository.findSoftDeletedExecutions();

		const executionIds = ids.map((o) => o.executionId);

		if (executionIds.length === 0) {
			this.logger.debug('Found no executions to hard-delete');

			return this.rates.hardDeletion;
		}

		try {
			this.logger.debug('Starting hard-deletion of executions', { executionIds });

			await this.binaryDataService.deleteMany(ids);

			await this.executionRepository.deleteByIds(executionIds);

			this.logger.debug('Hard-deleted executions', { executionIds });
		} catch (error) {
			this.logger.error('Failed to hard-delete executions', {
				executionIds,
				error: error instanceof Error ? error.message : `${error}`,
			});
		}

		/**
		 * For next batch, speed up hard-deletion cycle in high-volume case
		 * to prevent high concurrency from causing duplicate deletions.
		 */
		const isHighVolume = executionIds.length >= this.hardDeletionBatchSize;

		return isHighVolume ? 1 * TIME.SECOND : this.rates.hardDeletion;
	}
}
