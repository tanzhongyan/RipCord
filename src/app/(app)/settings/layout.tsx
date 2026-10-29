import { SettingsNav } from "./settings-nav";

export default function SettingsLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6 md:py-8">
      <h1 className="text-2xl font-bold">Settings</h1>
      <SettingsNav />
      {children}
    </div>
  );
}
