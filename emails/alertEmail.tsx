import * as React from "react";
import { Body, Container, Head, Heading, Html, Link, Preview, Text } from "@react-email/components";

interface AlertEmailProps {
	ruleName: string;
	severity: "warning" | "critical";
	state: "firing" | "resolved";
	summary: string;
	firedAt: Date;
	url: string;
}

const font = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif";

/** Sent to the admins a rule names when its alert fires (operational mail, never to customers). */
export const AlertEmail = ({ ruleName, severity, state, summary, firedAt, url }: AlertEmailProps) => (
	<Html>
		<Head />
		<Preview>{`${state === "firing" ? "Firing" : "Resolved"}: ${ruleName}`}</Preview>
		<Body style={{ backgroundColor: "#ffffff" }}>
			<Container style={{ padding: "0 12px", margin: "0 auto", maxWidth: "560px" }}>
				<Text
					style={{
						fontFamily: font,
						fontSize: "12px",
						letterSpacing: "0.08em",
						color: severity === "critical" ? "#b42318" : "#8a5a00",
						margin: "32px 0 0",
					}}
				>
					{severity.toUpperCase()} ALERT, {state.toUpperCase()}
				</Text>
				<Heading style={{ fontFamily: font, fontSize: "22px", color: "#1f2328", margin: "8px 0 16px" }}>
					{ruleName}
				</Heading>
				<Text style={{ fontFamily: font, fontSize: "14px", color: "#1f2328", lineHeight: "22px" }}>
					{summary}
				</Text>
				<Text style={{ fontFamily: font, fontSize: "13px", color: "#57606a" }}>
					Fired {firedAt.toISOString().replace("T", " ").slice(0, 16)} UTC.
				</Text>
				<Link href={url} style={{ fontFamily: font, fontSize: "14px", color: "#2754C5" }}>
					Open the alert in the HelpHive console
				</Link>
				<Text style={{ fontFamily: font, fontSize: "12px", color: "#898989", marginTop: "32px" }}>
					You get this because an alert rule in the console lists you as a recipient.
				</Text>
			</Container>
		</Body>
	</Html>
);

export default AlertEmail;
