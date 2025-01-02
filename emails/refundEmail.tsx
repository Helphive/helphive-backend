import * as React from "react";
import { Body, Container, Head, Heading, Html, Img, Link, Preview, Text } from "@react-email/components";
import { PUBLIC_BUCKET, CLIENT_BASE_URL } from "../config/config";

interface RefundEmailProps {
	bookingId: string;
	refundAmount: number;
	refundId: string;
	refundCreated: Date;
	refundStatus: "pending" | "succeeded" | "failed" | "cancelled";
	destinationAccountType: string | undefined;
}

export const RefundEmail = ({
	bookingId,
	refundAmount,
	refundId,
	refundCreated,
	refundStatus,
	destinationAccountType,
}: RefundEmailProps) => {
	return (
		<Html>
			<Head />
			<Preview>Your refund details</Preview>
			<Body style={main}>
				<Container style={container}>
					<Heading style={h1}>Refund Processed</Heading>
					<Text style={{ ...text }}>Your refund has been processed with the following details:</Text>
					<Container style={detailsContainer}>
						<Text style={detailItem}>
							<strong>Booking ID:</strong> <span style={detailValue}>{bookingId}</span>
						</Text>
						<Text style={detailItem}>
							<strong>Refund Amount:</strong> <span style={detailValue}>${refundAmount.toFixed(2)}</span>
						</Text>
						<Text style={detailItem}>
							<strong>Refund ID:</strong> <span style={detailValue}>{refundId}</span>
						</Text>
						<Text style={detailItem}>
							<strong>Refund Date:</strong>{" "}
							<span style={detailValue}>{refundCreated.toLocaleString().toUpperCase()}</span>
						</Text>
						<Text style={detailItem}>
							<strong>Refund Status:</strong>{" "}
							<span style={detailValue}>
								{refundStatus.charAt(0).toUpperCase() + refundStatus.slice(1)}
							</span>
						</Text>
						<Text style={detailItem}>
							<strong>Destination Account Type:</strong>{" "}
							<span style={detailValue}>
								{destinationAccountType
									? destinationAccountType
											.split(" ")
											.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
											.join(" ")
									: ""}
							</span>
						</Text>
					</Container>
					<Text style={{ ...text, marginBottom: "14px" }}>
						If you have any questions, please contact our support team.
					</Text>
					<Img
						src={`https://storage.googleapis.com/${PUBLIC_BUCKET}/logo-light.png`}
						width="32"
						height="32"
						alt="HelpHive's Logo"
					/>
					<Text style={footer}>
						<Link href={`${CLIENT_BASE_URL}`} target="_blank" style={{ ...link, color: "#898989" }}>
							Helphive
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

RefundEmail.defaultProps = {
	bookingId: "#657H2G",
	refundAmount: 120.0,
	refundId: "#657H2G",
	refundCreated: new Date(),
	refundStatus: "succeeded",
	destinationAccountType: "card",
};

export default RefundEmail;

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

const detailsContainer = {
	backgroundColor: "#f9f9f9",
	padding: "16px",
	borderRadius: "8px",
	margin: "16px 0",
	border: "1px solid #e0e0e0",
};

const detailItem = {
	marginBottom: "8px",
	fontFamily:
		"-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif",
	fontSize: "14px",
	color: "#333",
};

const detailValue = {
	color: "#555",
};
