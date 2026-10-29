import type { StorybookConfig } from "@storybook/nextjs";

const config: StorybookConfig = {
  framework: { name: "@storybook/nextjs", options: {} },
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  addons: [],
};

export default config;
