import NextAuth, { User } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { getCsrfToken } from "next-auth/react";
import { SiweMessage } from "siwe";
import { EtherscanProvider } from "ethers";
import jsonwebtoken from "jsonwebtoken";
import { Secret } from "next-auth/jwt";
import {
  ApolloClient,
  InMemoryCache,
  from,
  HttpLink,
  gql,
} from "@apollo/client";
import { setContext } from "@apollo/client/link/context";
import { loadErrorMessages, loadDevMessages } from "@apollo/client/dev";

if (process.env.NODE_ENV !== "production") {
  // Adds messages only in a dev environment
  loadDevMessages();
  loadErrorMessages();
}

const CreateOrUpdateUserMutation = gql`
  mutation CreateOrUpdateUserByExternalId(
    $externalId: String!
    $displayName: String!
    $profileImage: ImagesObjRelInsertInput
  ) {
    insertUsersOne(
      object: {
        externalId: $externalId
        displayName: $displayName
        profileImage: $profileImage
      }
      onConflict: {
        constraint: users_external_id_key
        updateColumns: [externalId]
      }
    ) {
      id
      externalId
      createdAt
      updatedAt
    }
  }
`;

const CreateOrUpdateSquadsMutation = gql`
  mutation CreateOrUpdateSquads($squadObjects: [SquadsInsertInput!]!) {
    insertSquads(
      objects: $squadObjects
      onConflict: {
        constraint: squads_contract_address_token_id_key
        updateColumns: updatedAt
      }
    ) {
      returning {
        id
        displayName
        description
        brandColor
        image {
          id
          url
          altText
          description
          createdAt
          updatedAt
        }
        userSquadRelationships {
          userId
          squadId
          isAdmin
          createdAt
          updatedAt
        }
        createdAt
        updatedAt
      }
    }
  }
`;

const GetNFTsByWalletAddressMutation = gql`
  query GetNFTsByWalletAddress($address: String!) {
    ethereum {
      walletByAddress(address: $address) {
        address
        ensName
        walletNFTs {
          edges {
            node {
              nft {
                contractAddress
                tokenId
                name
                description
                metadata
              }
            }
          }
        }
      }
    }
  }
`;

// For more information on each option (and a full list of options) go to
// https://next-auth.js.org/configuration/options
export default async function auth(req: any, res: any) {
  const providers = [
    CredentialsProvider({
      name: "Ethereum",
      credentials: {
        message: {
          label: "Message",
          type: "text",
          placeholder: "0x0",
        },
        signature: {
          label: "Signature",
          type: "text",
          placeholder: "0x0",
        },
      },
      async authorize(credentials) {
        try {
          const siwe = new SiweMessage(
            JSON.parse(credentials?.message || "{}"),
          );

          if (typeof process.env.NEXTAUTH_URL === "undefined") {
            throw new Error("NEXTAUTH_URL is not defined.");
          }

          const nextAuthUrl = new URL(process.env.NEXTAUTH_URL);

          const result = await siwe.verify({
            signature: credentials?.signature || "",
            domain: nextAuthUrl.host,
            nonce: await getCsrfToken({ req }),
          });

          if (result.success) {
            return {
              id: siwe.address ?? "",
            } as User;
          }
          return { id: "" };
        } catch (e) {
          return { id: "" };
        }
      },
    }),
  ];

  const isDefaultSigninPage =
    req.method === "GET" && req.query.nextauth.includes("signin");

  // Hide Sign-In with Ethereum from default sign page
  if (isDefaultSigninPage) {
    providers.pop();
  }

  return await NextAuth(req, res, {
    providers,
    session: {
      strategy: "jwt",
    },
    secret: process.env.NEXTAUTH_SECRET,
    callbacks: {
      async session({ session, token }: { session: any; token: any }) {
        const { sub } = token;
        const provider = new EtherscanProvider(
          undefined,
          process.env.ETHERSCAN_API_KEY,
        );

        const ensName = await provider.lookupAddress(sub);
        const ensAvatarUrl = await provider.getAvatar(ensName ?? sub);
        // TODO: Get other metadata associated with address.
        //const ensResolver = await provider.getResolver(ensName);
        session.user.walletAddress = sub;
        session.user.name = ensName;
        session.user.imageSource = ensAvatarUrl;

        const httpLink = new HttpLink({
          uri: process.env.NEXT_PUBLIC_GRAPHQL_URL,
        });

        const authMiddleware = setContext(async (_operation, { headers }) => {
          return {
            headers: {
              ...headers,
              "x-hasura-admin-secret": process.env.HASURA_ADMIN_SECRET,
              "x-hasura-role": "user-admin",
            },
          };
        });

        const graphqlClient = new ApolloClient({
          link: from([authMiddleware, httpLink]),
          cache: new InMemoryCache(),
        });

        console.log(ensAvatarUrl);

        const { data: userData } = await graphqlClient.mutate({
          mutation: CreateOrUpdateUserMutation,
          variables: {
            externalId: sub,
            displayName: ensName ?? sub,
            profileImage: ensAvatarUrl
              ? {
                  data: {
                    url: ensAvatarUrl,
                  },
                }
              : undefined,
          },
        });

        const {
          insertUsersOne: { id: userId },
        } = userData;

        session.user.id = userId;

        const encodedToken = jsonwebtoken.sign(
          {
            ...token,
            "https://hasura.io/jwt/claims": {
              "x-hasura-default-role": "user",
              "x-hasura-allowed-roles": ["user"],
              "x-hasura-user_id": userId,
              "x-hasura-user-id": userId,
            },
          },
          process.env.HASURA_JWT_SECRET as Secret,
          { algorithm: "HS256" },
        );
        session.token = encodedToken;

        const { data: nftsData } = await graphqlClient.query({
          query: GetNFTsByWalletAddressMutation,
          variables: { address: sub },
        });

        const squadObjects =
          nftsData?.ethereum?.walletByAddress?.walletNFTs?.edges?.map(
            ({
              node: {
                nft: {
                  contractAddress = "",
                  tokenId = "",
                  name: displayName = "",
                  description = "",
                  metadata: {
                    image: url = "",
                    name: altText = "",
                    description: imageDescription = "",
                    background_color: brandColor = "",
                  } = {},
                } = {},
              } = {},
            } = {}) => ({
              contractAddress,
              tokenId: tokenId.toString(),
              displayName: displayName || contractAddress || "",
              description,
              brandColor,
              image: !!url
                ? {
                    data: {
                      url,
                      altText,
                      description: imageDescription,
                    },
                  }
                : undefined,
              userSquadRelationships: {
                data: { isAdmin: true, userId },
                onConflict: {
                  constraint: "user_squad_relationships_pkey",
                  updateColumns: ["updatedAt"],
                },
              },
            }),
          );

        const { data: squadsData } = await graphqlClient.mutate({
          mutation: CreateOrUpdateSquadsMutation,
          variables: {
            squadObjects,
          },
        });

        return session;
      },
    },
  });
}
