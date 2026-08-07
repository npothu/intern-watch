import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    <div className="flex min-h-dvh flex-1 items-center justify-center bg-bg p-6 text-ink">
      <SignIn
        appearance={{
          variables: {
            colorPrimary: "#33604a",
            colorPrimaryForeground: "#f2f8f4",
            colorBackground: "#fcfbf8",
            borderRadius: "6px",
          },
        }}
      />
    </div>
  );
}
