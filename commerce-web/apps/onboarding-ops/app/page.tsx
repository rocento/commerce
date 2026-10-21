export default function Page() {
  return (
    <main>
      <a className="brand" href="/">
        rocento<span> OPERATIONS</span>
      </a>
      <section>
        <div className="lock">⌑</div>
        <p className="eyebrow">STAFF ACCESS ONLY</p>
        <h1>The control room.</h1>
        <p>
          One place to manage customers, stores, billing, and infrastructure.
        </p>
        <div className="notice">
          <strong>Staff operations are outside this project phase</strong>
          <p>
            This console is unavailable while onboarding focuses on customer
            setup. Customer accounts cannot access it.
          </p>
        </div>
        <button disabled>Staff sign-in unavailable</button>
        <small>Local foundation · no operational data exposed</small>
      </section>
      <footer>ROCENTO INTERNAL · AUTHORIZED TEAM MEMBERS ONLY</footer>
    </main>
  );
}
