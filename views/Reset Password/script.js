document.addEventListener("DOMContentLoaded", function () {
	const resetPasswordButton = document.getElementById("resetPasswordButton");

	resetPasswordButton.addEventListener("click", async function (event) {
		event.preventDefault();

		const urlParams = new URLSearchParams(window.location.search);
		const token = urlParams.get("token");

		console.log(token);

		if (!token) {
			alert("Token is missing");
			return;
		}

		const password = document.querySelector('input[name="password"]').value;
		const confirmPassword = document.querySelector('input[name="confirmPassword"]').value;

		if (password !== confirmPassword) {
			alert("Passwords do not match");
			return;
		}

		const response = await fetch("/auth/reset-password", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ password, confirmPassword, token }),
		});

		if (response.ok) {
			// Handle success
			alert("Password reset successfully");
		} else {
			// Handle error
			const errorData = await response.json();
			alert("Error: " + errorData.message);
		}
	});
});
