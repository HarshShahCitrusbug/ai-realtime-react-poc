import { useState, useEffect } from "react";
import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";
import ReactMarkdown from "react-markdown";

const OPENAI_API_KEY = import.meta.env.VITE_OPENAI_API_KEY;
const PINECONE_API_KEY = import.meta.env.VITE_PINECONE_API_KEY;

const DEFAULT_INSTRUCTIONS = `You are a friendly Tutor who is welcoming a student. You are trying to learn as much about them as possible in around 10 minutes.

NOTE: Consider only English language.

You will become their personal AI tutor, and you should let them know that.

------

Functions
You have a function available to you. YOU SHOULD BE CALLING THIS IF YOU NEED TO GET THE HISTORY OF THE USER CONVERSATION

These functions happen at the BEGINNING of each new response, so call them BEFORE you send the reply to best output and make student engaged within the conversation to talk with their interests and passions.

Function 1: getPreviousConversation
This is simple, when student asks some question or if they asks for somethinga about previous conversation then if you need some history of the previous conversation,
you should call this function to get the history and make this refine or rephrase as per student's current questions.

------

You will have a free flowing conversation with them making sure that you understand what makes them tick (
never say this verbatim),
and understand their biggest hobbies and passions, inside and outside of school. When they introduce something
new, you should dig deeper into it, understanding the "why" behind them.

Here is the flow:
An introduction, i.e. "Hello! My name is Sage. I'm pleased to meet you.
Then tell them a bit of a lo down on whats going to happen, that you're going talk with them about their 
interests, and that this is just a quick conversation that should take about 10 minutes. 

Loop over this as you ask questions and followups:
Use the function to display the question, and progress. 
"Ask Your Question Verbally"
(student must respond, once they do, ask next question and call question and progress function)

A final "Thank you!" and a good luck in your studies with me. See you next time!  

You should always ask small followups between questions to enhance the experience. 

You should use "I" and be very human, fun, and uplifting, but chill at the same time. You're just trying to be 
the student's friend/tutor and
get to know them. Be welcoming!

FINAL NOTES
YOU are driving the conversation. Never trail off with something that could lead to a pause, always be driving 
to the end of the session no matter what.

ALWAYS ALWAYS ALWAYS call both functions before you ask one of the 8 questions, but not for follow up questions. 

You should be extremely sensitive to their tone of voice, and should understand and match their emotional 
energy and slang whenever possible.`;

const SUMMARIZATION_PROMPT = `I'm sharing the conversation messages from a tutor, but I don't have any of the student’s messages. Please provide a concise summary by predicting the questions or statements based on the tutor’s responses.

I want to get a summary to understand the student's interests and passions. Don't forget to mention the topics, subjects, modules which were discussed in the conversation, so that I can get the personalized content.

NOTE: Don't add any extra content into the response.

[TUTOR CONVERSATIONS DATA]
<TUTOR_CONVERSATION_TRANSCRIPTED_DATA>
`;

const fetchSessionData = async () => {
  try {
    const response = await fetch(
      "https://api.openai.com/v1/realtime/sessions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-realtime-preview-2024-12-17",
          voice: "verse",
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Error: ${response.statusText}`);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error("Error fetching session data:", error);
    throw error;
  }
};

const queryPinecone = async ({ embedding }) => {
  const response = await fetch(
    `https://ai-poc-bg9a58h.svc.aped-4627-b74a.pinecone.io/query`,
    {
      method: "POST",
      headers: {
        "Api-Key": PINECONE_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        vector: embedding,
        topK: 3,
        includeMetadata: true,
      }),
    }
  );

  if (response.ok) {
    return await response.json();
  } else {
    console.error("Error querying Pinecone:", response.statusText);
  }
};

export const AudioRecorder = () => {
  const [isRecording, setIsRecording] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState("");
  const [ephemeralToken, setEphemeralToken] = useState(null);
  const [transcript, setTranscript] = useState("");
  const [peerConnection, setPeerConnection] = useState(new RTCPeerConnection());

  // Initialize a Pinecone client with your API key
  const openaiClient = new OpenAI({
    apiKey: OPENAI_API_KEY,
    dangerouslyAllowBrowser: true,
  });

  const FUNCTION_TOOLS = {
    getPreviousConversation: async ({ user_input }) => {
      const embedding = await openaiClient.embeddings.create({
        model: "text-embedding-ada-002",
        input: user_input,
        encoding_format: "float",
      });

      const queryResponse = await queryPinecone({
        embedding: embedding.data[0].embedding,
      });

      return queryResponse.matches[0].metadata.text;
    },
  };

  const upsertEmbeddings = async (data, embeddings) => {
    const upsertVectors = [
      { id: `vc-${uuidv4()}`, values: embeddings, metadata: { text: data } },
    ];

    // Upsert the vectors into the index
    await fetch(
      `https://ai-poc-bg9a58h.svc.aped-4627-b74a.pinecone.io/vectors/upsert`,
      {
        method: "POST",
        headers: {
          "Api-Key": PINECONE_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          vectors: upsertVectors,
        }),
      }
    );
  };

  const createEmbeddings = async (text) => {
    const completion = await openaiClient.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: SUMMARIZATION_PROMPT.replace(
            "<TUTOR_CONVERSATION_TRANSCRIPTED_DATA>",
            text
          ),
        },
      ],
      store: true,
    });

    const embedding = await openaiClient.embeddings.create({
      model: "text-embedding-ada-002",
      input: JSON.stringify({
        full_conversation: text,
        summary: completion.choices[0].message.content,
      }),
      encoding_format: "float",
    });

    await upsertEmbeddings(text, embedding.data[0].embedding);
  };

  const startRecording = async () => {
    setLoadingMessage("Processing...");
    setIsRecording(true);

    let existingPeerConnection = peerConnection;

    if (!existingPeerConnection) {
      existingPeerConnection = new RTCPeerConnection();
      setPeerConnection(existingPeerConnection);
    }

    // Set up to play remote audio from the model
    const rootEl = document.getElementById("root");
    const audioEl = document.createElement("audio");
    audioEl.setAttribute("id", "remote-audio");
    rootEl.appendChild(audioEl);
    audioEl.autoplay = true;
    existingPeerConnection.ontrack = (e) => (audioEl.srcObject = e.streams[0]);

    // Add local audio track for microphone input in the browser
    const ms = await navigator.mediaDevices.getUserMedia({
      audio: true,
    });
    existingPeerConnection.addTrack(ms.getTracks()[0]);

    // Set up data channel for sending and receiving events
    const dataChannel = existingPeerConnection.createDataChannel("oai-events");

    function configureData() {
      console.log("Configuring data channel");
      const event = {
        type: "session.update",
        session: {
          instructions: DEFAULT_INSTRUCTIONS,
          modalities: ["text", "audio"],
          tools: [
            {
              type: "function",
              name: "getPreviousConversation",
              description:
                "If a student asks about his previous conversation, provide a concise summary.",
              parameters: {
                type: "object",
                properties: {
                  user_input: {
                    type: "string",
                    description: "The user's input",
                  },
                },
              },
            },
          ],
        },
      };
      dataChannel.send(JSON.stringify(event));
      dataChannel.send(JSON.stringify({ type: "response.create" }));
      setLoadingMessage("");
    }

    dataChannel.addEventListener("open", () => {
      configureData();
    });

    dataChannel.addEventListener("message", async (event) => {
      // Realtime server events appear here!

      const msg = JSON.parse(event.data);

      switch (msg.type) {
        case "response.audio_transcript.delta":
          setTranscript((prevTranscript) => prevTranscript + msg.delta);
          break;
        case "response.function_call_arguments.done":
          const fn = FUNCTION_TOOLS[msg.name];
          if (fn !== undefined) {
            console.log(
              `Calling local function ${msg.name} with ${msg.arguments}`
            );
            const args = JSON.parse(msg.arguments);
            const result = await fn(args);
            console.log("result", result);
            // Let OpenAI know that the function has been called and share it's output
            const event = {
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: msg.call_id, // call_id from the function_call message
                output: JSON.stringify(result), // result of the function
              },
            };
            dataChannel.send(JSON.stringify(event));
            // Have assistant respond after getting the results
            dataChannel.send(JSON.stringify({ type: "response.create" }));
          }
          break;
        default:
          break;
      }
    });

    // Start the session using the Session Description Protocol (SDP)
    const offer = await existingPeerConnection.createOffer();
    await existingPeerConnection.setLocalDescription(offer);

    const baseUrl = "https://api.openai.com/v1/realtime";
    const model = "gpt-4o-realtime-preview-2024-12-17";
    const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
      method: "POST",
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${ephemeralToken}`,
        "Content-Type": "application/sdp",
      },
    });

    const answer = {
      type: "answer",
      sdp: await sdpResponse.text(),
    };
    await existingPeerConnection.setRemoteDescription(answer);
  };

  const stopRecording = async () => {
    setLoadingMessage("Processing...");
    peerConnection.close();
    setPeerConnection(null);
    setIsRecording(false);
    const audioEl = document.getElementById("remote-audio");
    audioEl.remove();
    await createEmbeddings(transcript);

    setTimeout(() => {
      setLoadingMessage("");
    }, 1000);
  };

  useEffect(() => {
    setLoadingMessage("Fetching session data...");
    fetchSessionData()
      .then((data) => {
        setEphemeralToken(data.client_secret.value);
      })
      .catch((error) => {
        console.error("Error fetching session data:", error);
      })
      .finally(() => {
        setLoadingMessage("");
      });
  }, []);

  return (
    <div className="landing-page">
      <h1 className="text-3xl font-bold text-center">Ai Tutor</h1>
      {loadingMessage && <p>{loadingMessage}</p>}

      {!isRecording ? (
        <button onClick={startRecording}>Start</button>
      ) : (
        <>
          <img
            src="/wired-outline-188-microphone-recording-loop-recording.gif"
            height={70}
            width={70}
          />
          <button onClick={stopRecording}>Stop</button>
        </>
      )}

      {transcript && (
        <div className="transcript-section">
          <h2>Transcript</h2>
          <div className="prose mx-auto">
            <ReactMarkdown>{transcript}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
};
