export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      animals: {
        Row: {
          emoji: string
          id: string
          label: string
        }
        Insert: {
          emoji: string
          id: string
          label: string
        }
        Update: {
          emoji?: string
          id?: string
          label?: string
        }
        Relationships: []
      }
      colors: {
        Row: {
          id: string
          label: string
        }
        Insert: {
          id: string
          label: string
        }
        Update: {
          id?: string
          label?: string
        }
        Relationships: []
      }
      connections: {
        Row: {
          created_at: string
          person_1_id: string
          person_2_id: string
        }
        Insert: {
          created_at?: string
          person_1_id: string
          person_2_id: string
        }
        Update: {
          created_at?: string
          person_1_id?: string
          person_2_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "connections_person_1_id_fkey"
            columns: ["person_1_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "connections_person_2_id_fkey"
            columns: ["person_2_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      devices: {
        Row: {
          id: string
          last_seen_at: string
          name: string
          person_id: string
        }
        Insert: {
          id: string
          last_seen_at?: string
          name: string
          person_id: string
        }
        Update: {
          id?: string
          last_seen_at?: string
          name?: string
          person_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "devices_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      pairing_code_redemptions: {
        Row: {
          code: string
          created_at: string
          from_person_id: string
        }
        Insert: {
          code: string
          created_at?: string
          from_person_id: string
        }
        Update: {
          code?: string
          created_at?: string
          from_person_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "pairing_code_redemptions_code_fkey"
            columns: ["code"]
            isOneToOne: true
            referencedRelation: "pairing_codes"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "pairing_code_redemptions_from_person_id_fkey"
            columns: ["from_person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      pairing_codes: {
        Row: {
          code: string
          created_at: string
          person_id: string
          purpose: string
        }
        Insert: {
          code: string
          created_at?: string
          person_id: string
          purpose: string
        }
        Update: {
          code?: string
          created_at?: string
          person_id?: string
          purpose?: string
        }
        Relationships: [
          {
            foreignKeyName: "pairing_codes_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      people: {
        Row: {
          animal_id: string | null
          auth_user_id: string
          color_id: string | null
          created_at: string
          id: string
        }
        Insert: {
          animal_id?: string | null
          auth_user_id: string
          color_id?: string | null
          created_at?: string
          id?: string
        }
        Update: {
          animal_id?: string | null
          auth_user_id?: string
          color_id?: string | null
          created_at?: string
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "people_animal_id_fkey"
            columns: ["animal_id"]
            isOneToOne: false
            referencedRelation: "animals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "people_color_id_fkey"
            columns: ["color_id"]
            isOneToOne: false
            referencedRelation: "colors"
            referencedColumns: ["id"]
          },
        ]
      }
      share_request_responses: {
        Row: {
          accepted: boolean
          accepted_by_device_id: string | null
          created_at: string
          request_id: string
        }
        Insert: {
          accepted: boolean
          accepted_by_device_id?: string | null
          created_at?: string
          request_id: string
        }
        Update: {
          accepted?: boolean
          accepted_by_device_id?: string | null
          created_at?: string
          request_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "share_request_responses_accepted_by_device_id_fkey"
            columns: ["accepted_by_device_id"]
            isOneToOne: false
            referencedRelation: "devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "share_request_responses_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: true
            referencedRelation: "share_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      share_requests: {
        Row: {
          created_at: string
          expires_at: string
          from_device_id: string
          from_person_id: string
          id: string
          payload: Json
          to_person_id: string
        }
        Insert: {
          created_at?: string
          expires_at: string
          from_device_id: string
          from_person_id: string
          id?: string
          payload: Json
          to_person_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          from_device_id?: string
          from_person_id?: string
          id?: string
          payload?: Json
          to_person_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "share_requests_from_device_id_fkey"
            columns: ["from_device_id"]
            isOneToOne: false
            referencedRelation: "devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "share_requests_from_person_id_fkey"
            columns: ["from_person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "share_requests_to_person_id_fkey"
            columns: ["to_person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      can_access_share_request: {
        Args: { share_request_id: string }
        Returns: boolean
      }
      current_person_id: { Args: never; Returns: string }
      people_are_connected: {
        Args: { other_person_id: string }
        Returns: boolean
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const

