import { HARNESS_MEMBER_ID } from '../constants.js';

/** Runtime identities are administered by their runtime owner. */
export const isSystemMember = (id: string): boolean => id === HARNESS_MEMBER_ID;
export const personMemberSql = (id: string): string => `${id} <> '${HARNESS_MEMBER_ID}'`;
