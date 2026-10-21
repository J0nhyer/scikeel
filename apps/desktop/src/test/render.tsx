import { render } from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { AppShell } from "@/app/layout/AppShell";
import { AdminAnalyticsLayout } from "@/app/layout/AdminAnalyticsLayout";
import { LiveSessionPage } from "@/app/routes/LiveSessionPage";
import { AdminAnalyticsPage } from "@/app/routes/AdminAnalyticsPage";
import { SessionPage } from "@/app/routes/SessionPage";
import { SkillsPage } from "@/app/routes/SkillsPage";
import { NotebooksPage } from "@/app/routes/NotebooksPage";
import { FilesPage } from "@/app/routes/FilesPage";
import { RunsPage } from "@/app/routes/RunsPage";
import { ProjectsPage } from "@/app/routes/ProjectsPage";
import { HistoryPage } from "@/app/routes/HistoryPage";
import { SettingsPage } from "@/app/routes/SettingsPage";
import { NotFound } from "@/app/routes/NotFound";

const testRoutes = [
  { path: "/admin/agent-analytics", element: <AdminAnalyticsLayout />, children: [{ index: true, element: <AdminAnalyticsPage /> }] },
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <LiveSessionPage /> },
      { path: "live", element: <LiveSessionPage /> },
      { path: "live/:sessionId", element: <LiveSessionPage /> },
      { path: "example/:sessionId", element: <SessionPage /> },
      { path: "skills", element: <SkillsPage /> },
      { path: "notebooks", element: <NotebooksPage /> },
      { path: "files", element: <FilesPage /> },
      { path: "runs", element: <RunsPage /> },
      { path: "projects", element: <ProjectsPage /> },
      { path: "history", element: <HistoryPage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "settings/:section", element: <SettingsPage /> },
      { path: "*", element: <NotFound /> },
    ],
  },
];

/** Render the whole app at a given route, using an in-memory router. */
export function renderAt(path: string) {
  const router = createMemoryRouter(testRoutes, { initialEntries: [path] });
  return render(<RouterProvider router={router} />);
}
