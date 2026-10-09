import { StudyRunner } from "@/features/runner/StudyRunner";
import { AccountDialog } from "@/features/auth/AccountDialog";
import { ToastHost } from "@/components/ui";

/**
 * The research app. It always renders: an account is optional, so nothing here
 * waits on one or asks for one.
 *
 * The account layer itself is started from `main.tsx` (`initAccount`), before
 * the first render. The one toast host is mounted here.
 */
export default function App() {
  return (
    <>
      <StudyRunner />
      <AccountDialog />
      <ToastHost />
    </>
  );
}
