import { ErrorNotice, type ErrorNoticeProps } from "./ErrorNotice";

export interface StateNoticeProps extends ErrorNoticeProps {
  /** Retained for source compatibility; an active issue always keeps its reopen control. */
  dismissFully?: boolean;
}

/** Compatibility wrapper for the former inline notice. The card owns the
 *  message; this component only registers it and renders the reopen control. */
export function StateNotice(props: StateNoticeProps) {
  return <ErrorNotice {...props} />;
}
