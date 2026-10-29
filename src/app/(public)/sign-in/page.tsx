import { SignInForm } from "~/features/identity";

export default function SignInPage() {
  return (
    <div className="flex flex-1 flex-col items-center bg-slate-950 px-4 py-16 text-white">
      <div className="flex w-full max-w-sm flex-col items-center gap-8">
        <div className="flex flex-col items-center gap-2">
          <h1 className="text-4xl font-bold">RipCord</h1>
          <p className="text-sm">Sign in to continue.</p>
        </div>
        <SignInForm />
      </div>
    </div>
  );
}
