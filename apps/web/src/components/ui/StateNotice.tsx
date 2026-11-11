import { ErrorNotice, type ErrorNoticeProps } from "./ErrorNotice";

export type StateNoticeProps = ErrorNoticeProps;

/** Compatibility wrapper for the former inline notice. The card owns the
 *  message; closing it removes the notice and leaves only a labeled recovery
 *  action when the caller did not ask for a full dismissal. */
export function StateNotice(props: StateNoticeProps) {
  return <ErrorNotice {...props} />;
}
