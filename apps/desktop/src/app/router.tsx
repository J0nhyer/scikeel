import { createBrowserRouter, Navigate, type RouteObject } from "react-router-dom";
import { AppShell } from "./layout/AppShell";
import { LiveSessionPage } from "./routes/LiveSessionPage";
import { NotFound } from "./routes/NotFound";

export const routes: RouteObject[] = [
  {path:'/admin/agent-analytics',HydrateFallback:()=>null,lazy:()=>import('./layout/AdminAnalyticsLayout').then(module=>({Component:module.AdminAnalyticsLayout})),children:[{index:true,HydrateFallback:()=>null,lazy:()=>import('./routes/AdminAnalyticsPage').then(module=>({Component:module.AdminAnalyticsPage}))}]},
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/live" replace /> },
      { path: "live", element: <LiveSessionPage /> },
      { path: "live/:sessionId", element: <LiveSessionPage /> },
      { path: "example/:sessionId", HydrateFallback:()=>null, lazy:()=>import('./routes/SessionPage').then(module=>({Component:module.SessionPage})) },
      { path: "skills", HydrateFallback:()=>null, lazy:()=>import('./routes/SkillsPage').then(module=>({Component:module.SkillsPage})) },
      { path: "notebooks", HydrateFallback:()=>null, lazy:()=>import('./routes/NotebooksPage').then(module=>({Component:module.NotebooksPage})) },
      { path: "files", HydrateFallback:()=>null, lazy:()=>import('./routes/FilesPage').then(module=>({Component:module.FilesPage})) },
      { path: "runs", HydrateFallback:()=>null, lazy:()=>import('./routes/RunsPage').then(module=>({Component:module.RunsPage})) },
      { path: "projects", HydrateFallback:()=>null, lazy:()=>import('./routes/ProjectsPage').then(module=>({Component:module.ProjectsPage})) },
      { path: "history", HydrateFallback:()=>null, lazy:()=>import('./routes/HistoryPage').then(module=>({Component:module.HistoryPage})) },
      { path: "settings", HydrateFallback:()=>null, lazy:()=>import('./routes/SettingsPage').then(module=>({Component:module.SettingsPage})) },
      { path: "settings/:section", HydrateFallback:()=>null, lazy:()=>import('./routes/SettingsPage').then(module=>({Component:module.SettingsPage})) },
      { path: "*", element: <NotFound /> },
    ],
  },
];

export const router = createBrowserRouter(routes);
