import * as React from "react";
import { Body, Container, Head, Heading, Html, Img, Link, Preview, Text } from "@react-email/components";

interface ResetPasswordEmailProps {
	baseUrl: string;
	loginCode?: string;
	verificationLink?: string;
}

export const NotionResetPasswordEmail = ({ baseUrl, loginCode, verificationLink }: ResetPasswordEmailProps) => {
	const magicLink = verificationLink || "";
	return (
		<Html>
			<Head />
			<Preview>Reset Your Password using the button below</Preview>
			<Body style={main}>
				<Container style={container}>
					<Heading style={h1}>Reset Your Password</Heading>
					<Text style={{ ...text }}>You requested for a password reset request. Please click below:</Text>
					<Container
						style={{
							width: "100%",
							display: "flex",
							justifyContent: "center",
							alignItems: "center",
						}}
					>
						<a
							href={magicLink}
							target="_blank"
							style={{
								...button,
								display: "inline-block",
								padding: "10px 20px",
								textAlign: "center",
								textDecoration: "none",
								color: "#fff",
								backgroundColor: "#FF5740",
								borderRadius: "5px",
								marginBottom: "16px",
							}}
						>
							Reset Password
						</a>
					</Container>
					<Text style={{ ...text, marginBottom: "14px" }}>Or, copy and paste this link in your browser:</Text>
					<Container
						style={{
							backgroundColor: "#ebebeb",
							borderRadius: "5px",
							border: "1px solid #ebebeb",
							display: "inline-block",
							padding: "16px 4.5%",
							width: "100%",
							maxWidth: "100%",
							wordBreak: "break-all",
						}}
					>
						<Text
							style={{
								textWrap: "wrap",
								wordWrap: "break-word",
								maxWidth: "100%",
								fontSize: "11px",
							}}
						>
							<code>{loginCode}</code>
						</Text>
					</Container>
					<Text
						style={{
							...text,
							color: "#ababab",
							marginTop: "14px",
							marginBottom: "16px",
						}}
					>
						If you didn&apos;t request a password reset, you can safely ignore this email.
					</Text>
					<Text
						style={{
							...text,
							color: "#ababab",
							marginTop: "12px",
							marginBottom: "38px",
						}}
					>
						Note: This is a one-time link and will expire in 1 day.
					</Text>
					<Img src={`${baseUrl}/favicon.png`} width="32" height="32" alt="HelpHive's Logo" />
					<Text style={footer}>
						<Link href="https://helphive.io" target="_blank" style={{ ...link, color: "#898989" }}>
							HelpHive.io
						</Link>
						, the all-in-one-marketplace
						<br />
						for your professional home services needs.
					</Text>
				</Container>
			</Body>
		</Html>
	);
};

NotionResetPasswordEmail.PreviewProps = {
	baseUrl: "http://localhost:8080",
	loginCode: "sparo-ndigo-amurt-secan",
	verificationLink: "http://localhost:8080/auth/verify-email?token=hello-world",
} as ResetPasswordEmailProps;

export default NotionResetPasswordEmail;

const main = {
	backgroundColor: "#ffffff",
};

const container = {
	paddingLeft: "12px",
	paddingRight: "12px",
	margin: "0 auto",
};

const h1 = {
	color: "#333",
	fontFamily:
		"-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif",
	fontSize: "24px",
	fontWeight: "bold",
	margin: "40px 0",
	padding: "0",
};

const link = {
	color: "#2754C5",
	fontFamily:
		"-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif",
	fontSize: "14px",
	textDecoration: "underline",
};

const button = {
	fontFamily:
		"-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif",
	fontSize: "14px",
	fontWeight: "bold",
	color: "#ffffff",
	backgroundColor: "#FF5740",
	borderRadius: "5px",
	padding: "10px 20px",
	textAlign: "center",
	textDecoration: "none",
};

const text = {
	color: "#333",
	fontFamily:
		"-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif",
	fontSize: "14px",
	margin: "24px 0",
};

const footer = {
	color: "#898989",
	fontFamily:
		"-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif",
	fontSize: "12px",
	lineHeight: "22px",
	marginTop: "12px",
	marginBottom: "24px",
};
