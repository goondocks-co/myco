import { read } from '../index.js';
import { LEARNING_STAGE_NAMES } from './ready.js';

const ready = read<[project: string, stages: string], { n: number }>({
  name: 'learningCounts.readyProject',
  sql: `SELECT EXISTS(SELECT 1 FROM learning_ready_projects
    WHERE stage IN (SELECT value FROM json_each(?2)) AND project_id=?1 AND ready>0) AS n`,
});

/** One keyed check per stage, returning one when this Project has ready work and zero otherwise. */
export const readyLearningProject = (project: string) => ready.bind(project, JSON.stringify(LEARNING_STAGE_NAMES));
