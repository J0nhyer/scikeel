import { expect, it } from "vitest";
import type { RouteObject } from "react-router-dom";
import { routes } from "@/app/router";
import { testRoutes } from "./render";

const flatten = (list: RouteObject[]): RouteObject[] =>
  list.flatMap((route) => [route, ...flatten(route.children ?? [])]);
const paths = (list: RouteObject[]): string[] =>
  flatten(list).map((route) => route.path ?? (route.index ? "index" : ""));

/** The test renderer keeps eager route components so a page renders in one
 *  pass. The shipped table loads them lazily, so both have to stay in step:
 *  a route that only exists in one of them is a route the tests never cover. */
it("keeps the shipped route table and the test routes in step", () => {
  expect(paths(routes)).toEqual(paths(testRoutes));
});

it("resolves every lazily loaded route to a component", async () => {
  for (const route of flatten(routes)) {
    if (typeof route.lazy !== "function") continue;
    const module = await route.lazy();
    expect(module.Component ?? module.element).toBeTruthy();
  }
});
