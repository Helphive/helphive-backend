import * as React from "react";
import { Body, Container, Head, Heading, Html, Preview, Text } from "@react-email/components";

// A plain message from the HelpHive team: support case replies and announcements. Text only (no links or images from
// admins); paragraphs come from blank lines in the body.
interface PlainMessageEmailProps {
	heading: string;
	body: string;
	footer?: string;
}

export const PlainMessageEmail = ({ heading, body, footer }: PlainMessageEmailProps) => {
	const paragraphs = body
		.split(/\n{2,}/)
		.map((p) => p.trim())
		.filter(Boolean);
	return (
		<Html>
			<Head />
			<Preview>{heading}</Preview>
			<Body style={main}>
				<Container style={container}>
					<Heading style={h1}>{heading}</Heading>
					{paragraphs.map((paragraph, index) => (
						<Text key={index} style={text}>
							{paragraph}
						</Text>
					))}
					{footer ? <Text style={muted}>{footer}</Text> : null}
				</Container>
			</Body>
		</Html>
	);
};

export default PlainMessageEmail;

const main = {
	backgroundColor: "#ffffff",
	fontFamily: "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
};
const container = { margin: "0 auto", padding: "24px 16px", maxWidth: "560px" };
const h1 = { color: "#1d1c1d", fontSize: "22px", fontWeight: 700, margin: "0 0 16px" };
const text = { color: "#1d1c1d", fontSize: "15px", lineHeight: "24px", whiteSpace: "pre-line" as const };
const muted = { color: "#6b6b6b", fontSize: "13px", lineHeight: "20px", marginTop: "24px" };
