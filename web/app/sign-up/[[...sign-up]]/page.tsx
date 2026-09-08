import { SignUp } from "@clerk/nextjs";

export default function SignUpPage() {
  return (
    <div className="flex min-h-dvh flex-1 items-center justify-center bg-bg p-6 text-ink">
      <SignUp />
    </div>
  );
}
