export const ATTR_CICD_WORKER_VERSION = 'cicd.worker.version'
export const ATTR_CICD_WORKER_IP_ADDRESS = 'cicd.worker.ip_address'
export const ATTR_CICD_WORKER_TYPE = 'cicd.worker.type'

export const ATTR_CICD_PIPELINE_TASK_STARTED_BY_ID =
  'cicd.pipeline.task.started_by.id'
export const ATTR_CICD_PIPELINE_TASK_STARTED_BY_NAME =
  'cicd.pipeline.task.started_by.name'

export const ATTR_CICD_PIPELINE_TASK_STEP_NAME = 'cicd.pipeline.task.step.name'
export const ATTR_CICD_PIPELINE_TASK_STEP_LOGS = 'cicd.pipeline.task.step.logs'
/**
 * Whether or not we had to adjust the start timestamp because Gitlab failed
 * to record an accurate timestamp in the logs.
 */
export const ATTR_CICD_PIPELINE_TASK_STEP_ADJUSTED_START_TS =
  'cicd.pipeline.task.step.adjusted_start_ts'

export const ATTR_GITLAB_PROJECT_ID = 'gitlab.project.id'
